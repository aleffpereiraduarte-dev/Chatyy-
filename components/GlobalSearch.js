/**
 * GlobalSearch — Spotlight-style unified search overlay.
 * Finds emails, chats, users, and feed posts in one surface.
 * Debounced 250ms to avoid hammering the backend on every keystroke.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Pressable,
  ScrollView, ActivityIndicator, Platform, StyleSheet, Image, Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import CachedImage from './CachedImage';
import AvatarCircle from './AvatarCircle';
import EmptyStateCard from './EmptyStateCard';
import {
  IconSearch, IconX, IconMail, IconMessageSquare, IconImage,
  IconUser, IconChevronRight, IconClock, IconFileText, IconFilm, IconFile,
} from './Icons';

// Spotlight-style brand accent — used everywhere the focus needs to pop.
const BRAND = '#7C3AED';
const RECENT_KEY = '@chatyy_global_recent_searches';
const MAX_RECENT = 6;
// Per-section preview cap. Anything beyond shows "Ver todos →".
const SECTION_PREVIEW = 3;

// Compact time formatter (Spotlight-grade): "agora", "5m", "2h", "ter", "12 mai".
function formatTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts * (ts < 1e12 ? 1000 : 1)) : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) {
    const days = ['dom','seg','ter','qua','qui','sex','sáb'];
    return days[d.getDay()];
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

const WEB = Platform.OS === 'web';

function resolveMedia(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url}`;
}

// Bold + tinted highlight of the matched substring within a result row.
// Mirrors the chat-new.js HighlightText pattern for visual consistency.
function HighlightText({ text, highlight, style, highlightColor }) {
  if (!highlight || !text) return <Text style={style} numberOfLines={1}>{text}</Text>;
  const lowerText = String(text).toLowerCase();
  const lowerHighlight = String(highlight).toLowerCase();
  const idx = lowerText.indexOf(lowerHighlight);
  if (idx === -1) return <Text style={style} numberOfLines={1}>{text}</Text>;
  const before = String(text).substring(0, idx);
  const match = String(text).substring(idx, idx + highlight.length);
  const after = String(text).substring(idx + highlight.length);
  return (
    <Text style={style} numberOfLines={1}>
      {before}
      <Text style={[style, { fontWeight: '700', color: highlightColor }]}>{match}</Text>
      {after}
    </Text>
  );
}

function Section({ title, children, colors, icon: Icon, totalCount, onSeeAll }) {
  // Header doubles as a "see all" affordance when the bucket overflows the
  // preview cap. Stays subtle (no full row) so the section list feels light.
  const showSeeAll = typeof totalCount === 'number' && totalCount > SECTION_PREVIEW && !!onSeeAll;
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
          {Icon && <Icon size={14} color={colors?.textSecondary} />}
          <Text style={{ fontSize: 11, fontWeight: '700', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {title}
          </Text>
        </View>
        {showSeeAll && (
          <TouchableOpacity onPress={onSeeAll} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: BRAND }}>
              Ver todos →
            </Text>
          </TouchableOpacity>
        )}
      </View>
      {children}
    </View>
  );
}

function Row({ leading, title, subtitle, time, onPress, colors, query }) {
  const titleStyle = { fontSize: 14.5, fontWeight: '500', color: colors?.text };
  const subtitleStyle = { fontSize: 12, color: colors?.textSecondary, marginTop: 2 };
  const highlightColor = colors?.primary || BRAND;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <HighlightText text={title} highlight={query} style={titleStyle} highlightColor={highlightColor} />
          </View>
          {!!time && (
            <Text style={{ fontSize: 11, color: colors?.textTertiary, fontVariant: ['tabular-nums'] }}>
              {time}
            </Text>
          )}
        </View>
        {!!subtitle && (
          <HighlightText text={subtitle} highlight={query} style={subtitleStyle} highlightColor={highlightColor} />
        )}
      </View>
      <IconChevronRight size={16} color={colors?.textTertiary} />
    </TouchableOpacity>
  );
}

// Spotlight-style filter chips — kept tight (5 items) so the row doesn't need
// to scroll on iPhone widths. Keys are stable internal IDs; labels stay PT.
const FILTERS = [
  { id: 'all',    label: 'Tudo' },
  { id: 'msg',    label: 'Mensagens' },
  { id: 'people', label: 'Pessoas' },
  { id: 'media',  label: 'Mídia' },
  { id: 'docs',   label: 'Arquivos' },
];

// Loose URL detector — matches plain http(s)://… and bare domain.tld/path forms.
const URL_RE = /(https?:\/\/[^\s]+)|(\b[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?\b)/i;

function hasLink(text) {
  if (!text) return false;
  return URL_RE.test(String(text));
}

// Apply filter to the unified result buckets. Returns the same shape so the
// existing render code keeps working without per-section forks. Each filter
// only emits the relevant bucket(s); the others come back empty.
function applyFilter(results, filterId) {
  const empty = { users: [], chats: [], emails: [], posts: [] };
  if (!results) return empty;
  const all = {
    users:  results.users  || [],
    chats:  results.chats  || [],
    emails: results.emails || [],
    posts:  results.posts  || [],
  };
  switch (filterId) {
    case 'people':
      return { ...empty, users: all.users };
    case 'convs':
      return { ...empty, chats: all.chats };
    case 'msg':
      // "Mensagens" = chat conversations + emails (text-based threads).
      return { ...empty, chats: all.chats, emails: all.emails };
    case 'media':
      // Only feed posts whose media type is image or video.
      return {
        ...empty,
        posts: all.posts.filter(p => {
          const ty = String(p?.type || '').toLowerCase();
          return ty === 'image' || ty === 'video' || ty === 'photo' || ty === 'carousel';
        }),
      };
    case 'audio':
      return {
        ...empty,
        posts: all.posts.filter(p => String(p?.type || '').toLowerCase() === 'audio' || String(p?.type || '').toLowerCase() === 'voice'),
      };
    case 'docs':
      return {
        ...empty,
        posts: all.posts.filter(p => {
          const ty = String(p?.type || '').toLowerCase();
          return ty === 'document' || ty === 'doc' || ty === 'file' || ty === 'pdf';
        }),
      };
    case 'links':
      // Surface emails with URL in subject and posts with URL in caption.
      return {
        ...empty,
        emails: all.emails.filter(e => hasLink(e?.subject) || hasLink(e?.from)),
        posts:  all.posts.filter(p => hasLink(p?.caption)),
        chats:  all.chats.filter(c => hasLink(c?.name)),
      };
    case 'all':
    default:
      return all;
  }
}

function FilterChip({ label, active, onPress, colors }) {
  const brand = colors?.primary || '#7C3AED';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 999,
        marginRight: 8,
        backgroundColor: active ? brand : 'transparent',
        borderWidth: active ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors?.border || 'rgba(0,0,0,0.15)',
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? '700' : '500',
          color: active ? '#fff' : (colors?.text || '#000'),
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function GlobalSearch({
  visible, onClose, colors, isDark, t, router,
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState({ users: [], chats: [], emails: [], posts: [] });
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [recent, setRecent] = useState([]);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  // Cache results per (filter,query) so toggling chips doesn't refetch when
  // the underlying unified payload is the same. The unified search payload
  // itself is the same regardless of filter (we filter client-side), so this
  // cache is keyed by query alone — the filter purely re-derives.
  const cacheRef = useRef(new Map());

  // Hydrate recent searches when the modal opens (Spotlight empty-state).
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(RECENT_KEY);
        if (raw) setRecent(JSON.parse(raw) || []);
      } catch {}
    })();
  }, [visible]);

  // Persist a query to recents on result-tap. LRU + dedup, capped to MAX_RECENT.
  const pushRecent = useCallback(async (term) => {
    const v = String(term || '').trim();
    if (v.length < 2) return;
    try {
      const existing = recent.filter(s => s !== v);
      const next = [v, ...existing].slice(0, MAX_RECENT);
      setRecent(next);
      await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
  }, [recent]);

  const clearRecent = useCallback(async () => {
    setRecent([]);
    try { await AsyncStorage.removeItem(RECENT_KEY); } catch {}
  }, []);

  // Autofocus when the overlay opens
  useEffect(() => {
    if (visible) {
      const h = setTimeout(() => { inputRef.current?.focus?.(); }, 140);
      return () => clearTimeout(h);
    } else {
      setQ('');
      setResults({ users: [], chats: [], emails: [], posts: [] });
      setFilter('all');
      cacheRef.current.clear();
    }
  }, [visible]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = q.trim();
    if (term.length < 2) {
      setResults({ users: [], chats: [], emails: [], posts: [] });
      setLoading(false);
      return;
    }
    // Cache hit — reuse the unified payload, no network roundtrip.
    const cached = cacheRef.current.get(term);
    if (cached) {
      setResults(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.searchGlobal(term);
        // Defensive defaults — server pode omitir buckets vazios e os
        // .length acessados depois quebrariam.
        if (r?.success) {
          const data = {
            users: r.data?.users || [],
            chats: r.data?.chats || [],
            emails: r.data?.emails || [],
            posts: r.data?.posts || [],
          };
          cacheRef.current.set(term, data);
          // Cap cache to last ~20 queries to avoid unbounded growth.
          if (cacheRef.current.size > 20) {
            const firstKey = cacheRef.current.keys().next().value;
            cacheRef.current.delete(firstKey);
          }
          setResults(data);
        }
      } catch {}
      setLoading(false);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q]);

  // Derived view = filter applied to the unified payload. Cheap memo so we
  // don't rebuild on every render.
  const viewResults = React.useMemo(() => applyFilter(results, filter), [results, filter]);

  const close = useCallback(() => {
    Keyboard.dismiss?.();
    onClose?.();
  }, [onClose]);

  const go = (path) => {
    // Persist current query so the Recentes section reflects what user just opened.
    if (q.trim().length >= 2) pushRecent(q.trim());
    close();
    setTimeout(() => router?.push(path), 60);
  };

  const hasAny = (viewResults.users?.length ?? 0) + (viewResults.chats?.length ?? 0) + (viewResults.emails?.length ?? 0) + (viewResults.posts?.length ?? 0) > 0;

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={close}>
        <Pressable
          style={{
            marginTop: Platform.OS === 'ios' ? 60 : 30,
            marginHorizontal: 12,
            borderRadius: 16,
            backgroundColor: colors?.background || '#fff',
            maxHeight: '85%',
            overflow: 'hidden',
            ...(Platform.OS === 'web'
              ? { boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }
              : { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.3, shadowRadius: 24, elevation: 10 }),
          }}
          onPress={e => e.stopPropagation?.()}
        >
          {/* Search bar — Spotlight-grade. Larger height (52px) + brand-tinted
              icon container + clear-text X distinct from close-overlay X. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors?.border,
            }}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)',
              }}
            >
              <IconSearch size={18} color={BRAND} />
            </View>
            <TextInput
              ref={inputRef}
              value={q}
              onChangeText={setQ}
              placeholder={t?.('search.placeholder') || 'Buscar em tudo...'}
              placeholderTextColor={colors?.textTertiary}
              style={{
                flex: 1,
                fontSize: 18,
                fontWeight: '500',
                color: colors?.text,
                paddingVertical: 4,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {loading && <ActivityIndicator size="small" color={BRAND} />}
            {!loading && q.length > 0 && (
              <TouchableOpacity
                onPress={() => setQ('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
                }}
              >
                <IconX size={12} color={colors?.textSecondary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconX size={22} color={colors?.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Filter chips — WhatsApp-style horizontal scroll row.
              Only render when the user has typed something useful so we
              don't waste vertical space on the empty-state hint screen. */}
          {q.trim().length >= 2 && (
            <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
              >
                {FILTERS.map(f => (
                  <FilterChip
                    key={f.id}
                    label={f.label}
                    active={filter === f.id}
                    onPress={() => setFilter(f.id)}
                    colors={colors}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {/* Empty state — Spotlight pattern: surface recent searches so the
                user can re-run prior queries instead of staring at hint text. */}
            {q.trim().length < 2 && (
              <View>
                {recent.length > 0 ? (
                  <View style={{ marginTop: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                        <IconClock size={14} color={colors?.textSecondary} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                          {t?.('search.recent') || 'Recentes'}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={clearRecent} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.textTertiary }}>
                          {t?.('search.clearHistory') || 'Limpar'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {recent.map((r, i) => (
                      <TouchableOpacity
                        key={`${r}-${i}`}
                        onPress={() => { setQ(r); inputRef.current?.focus?.(); }}
                        activeOpacity={0.6}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}
                      >
                        <View style={{
                          width: 32, height: 32, borderRadius: 16,
                          alignItems: 'center', justifyContent: 'center',
                          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                        }}>
                          <IconClock size={14} color={colors?.textSecondary} />
                        </View>
                        <Text style={{ flex: 1, fontSize: 14.5, color: colors?.text }} numberOfLines={1}>
                          {r}
                        </Text>
                        <IconChevronRight size={16} color={colors?.textTertiary} />
                      </TouchableOpacity>
                    ))}
                    <View style={{ height: 16 }} />
                  </View>
                ) : (
                  <View style={{ padding: 40, alignItems: 'center' }}>
                    <Text style={{ color: colors?.textSecondary, fontSize: 13, textAlign: 'center' }}>
                      {t?.('search.hint') || 'Digite pra buscar em conversas, e-mails, pessoas, reels e arquivos.'}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {q.trim().length >= 2 && !loading && !hasAny && (
              <EmptyStateCard
                Icon={IconSearch}
                tone="neutral"
                title={(t?.('search.emptyTitle') || `Nenhum resultado para "${q.trim()}"`).replace('{query}', q.trim())}
                subtitle={t?.('search.emptySubtitle') || 'Tente outras palavras-chave ou verifique a ortografia'}
              />
            )}

            {/* Conversas — surface chats first (Spotlight ordem: most-actionable). */}
            {viewResults.chats.length > 0 && (
              <Section
                title={t?.('search.chats') || 'Conversas'}
                icon={IconMessageSquare}
                colors={colors}
                totalCount={viewResults.chats.length}
                onSeeAll={() => go(`/chat?q=${encodeURIComponent(q.trim())}`)}
              >
                {viewResults.chats.slice(0, SECTION_PREVIEW).map(c => (
                  <Row
                    key={c.id}
                    leading={<AvatarCircle name={c.name || String(c.id)} size={40} />}
                    title={c.name || (t?.('chat.untitled') || 'Conversa')}
                    subtitle={c.last_message || (c.type === 'group' ? (t?.('chat.group') || 'Grupo') : (t?.('chat.direct') || 'Conversa direta'))}
                    time={formatTime(c.last_message_at || c.updated_at)}
                    onPress={() => go(`/chat-conversation?id=${c.id}`)}
                    colors={colors}
                    query={q.trim()}
                  />
                ))}
              </Section>
            )}

            {/* Email */}
            {viewResults.emails.length > 0 && (
              <Section
                title={t?.('search.emails') || 'Email'}
                icon={IconMail}
                colors={colors}
                totalCount={viewResults.emails.length}
                onSeeAll={() => go(`/inbox?q=${encodeURIComponent(q.trim())}`)}
              >
                {viewResults.emails.slice(0, SECTION_PREVIEW).map((e, i) => (
                  <Row
                    key={`${e.folder}:${e.uid}:${i}`}
                    leading={
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors?.surface, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border }}>
                        <IconMail size={18} color={BRAND} />
                      </View>
                    }
                    title={e.subject || '(sem assunto)'}
                    subtitle={e.from}
                    time={formatTime(e.date || e.received_at)}
                    onPress={() => go(`/read?uid=${e.uid}&folder=${encodeURIComponent(e.folder)}`)}
                    colors={colors}
                    query={q.trim()}
                  />
                ))}
              </Section>
            )}

            {/* Pessoas */}
            {viewResults.users.length > 0 && (
              <Section
                title={t?.('search.users') || 'Pessoas'}
                icon={IconUser}
                colors={colors}
                totalCount={viewResults.users.length}
                onSeeAll={() => go(`/contacts?q=${encodeURIComponent(q.trim())}`)}
              >
                {viewResults.users.slice(0, SECTION_PREVIEW).map(u => (
                  <Row
                    key={u.email}
                    leading={<AvatarCircle email={u.email} name={u.name} size={40} />}
                    title={u.name || u.email}
                    subtitle={u.email}
                    onPress={() => go(`/u/${encodeURIComponent(u.email)}`)}
                    colors={colors}
                    query={q.trim()}
                  />
                ))}
              </Section>
            )}

            {/* Reels — only video posts. Files/Status get their own buckets below. */}
            {(() => {
              const reels = viewResults.posts.filter(p => {
                const ty = String(p?.type || '').toLowerCase();
                return ty === 'video' || ty === 'reel';
              });
              if (reels.length === 0) return null;
              return (
                <Section
                  title={t?.('search.reels') || 'Reels'}
                  icon={IconFilm}
                  colors={colors}
                  totalCount={reels.length}
                  onSeeAll={() => go(`/feed?q=${encodeURIComponent(q.trim())}&type=reels`)}
                >
                  {reels.slice(0, SECTION_PREVIEW).map(p => {
                    const thumbUrl = resolveMedia(p.thumbnail);
                    return (
                      <Row
                        key={p.id}
                        leading={
                          thumbUrl ? (
                            WEB
                              ? <img src={thumbUrl} style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} alt="" />
                              : <CachedImage source={{ uri: thumbUrl }} style={{ width: 40, height: 40, borderRadius: 8 }} resizeMode="cover" />
                          ) : (
                            <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: colors?.surface, alignItems: 'center', justifyContent: 'center' }}>
                              <IconFilm size={16} color={colors?.textSecondary} />
                            </View>
                          )
                        }
                        title={p.caption || (t?.('feed.untitled') || 'Reel')}
                        subtitle={p.author_email}
                        time={formatTime(p.created_at)}
                        onPress={() => go(`/feed/${p.id}`)}
                        colors={colors}
                        query={q.trim()}
                      />
                    );
                  })}
                </Section>
              );
            })()}

            {/* Files / Documentos */}
            {(() => {
              const files = viewResults.posts.filter(p => {
                const ty = String(p?.type || '').toLowerCase();
                return ty === 'file' || ty === 'document' || ty === 'doc' || ty === 'pdf';
              });
              if (files.length === 0) return null;
              return (
                <Section
                  title={t?.('search.files') || 'Arquivos'}
                  icon={IconFile || IconImage}
                  colors={colors}
                  totalCount={files.length}
                  onSeeAll={() => go(`/files?q=${encodeURIComponent(q.trim())}`)}
                >
                  {files.slice(0, SECTION_PREVIEW).map(p => (
                    <Row
                      key={p.id}
                      leading={
                        <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: colors?.surface, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border }}>
                          <IconFile size={18} color={BRAND} />
                        </View>
                      }
                      title={p.caption || p.filename || (t?.('feed.untitled') || 'Arquivo')}
                      subtitle={p.author_email}
                      time={formatTime(p.created_at)}
                      onPress={() => go(`/files/${p.id}`)}
                      colors={colors}
                      query={q.trim()}
                    />
                  ))}
                </Section>
              );
            })()}

            {/* Status / Reels-other / image posts — bucket the rest as "Publicações". */}
            {(() => {
              const others = viewResults.posts.filter(p => {
                const ty = String(p?.type || '').toLowerCase();
                return !['video','reel','file','document','doc','pdf'].includes(ty);
              });
              if (others.length === 0) return null;
              return (
                <Section
                  title={t?.('search.posts') || 'Publicações'}
                  icon={IconImage}
                  colors={colors}
                  totalCount={others.length}
                  onSeeAll={() => go(`/feed?q=${encodeURIComponent(q.trim())}`)}
                >
                  {others.slice(0, SECTION_PREVIEW).map(p => {
                    const thumbUrl = resolveMedia(p.thumbnail);
                    return (
                      <Row
                        key={p.id}
                        leading={
                          thumbUrl ? (
                            WEB
                              ? <img src={thumbUrl} style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} alt="" />
                              : <CachedImage source={{ uri: thumbUrl }} style={{ width: 40, height: 40, borderRadius: 8 }} resizeMode="cover" />
                          ) : (
                            <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: colors?.surface }} />
                          )
                        }
                        title={p.caption || (t?.('feed.untitled') || 'Post')}
                        subtitle={p.author_email}
                        time={formatTime(p.created_at)}
                        onPress={() => go(`/feed/${p.id}`)}
                        colors={colors}
                        query={q.trim()}
                      />
                    );
                  })}
                </Section>
              );
            })()}
            <View style={{ height: 16 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
