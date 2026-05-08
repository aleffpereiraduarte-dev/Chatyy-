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
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import CachedImage from './CachedImage';
import AvatarCircle from './AvatarCircle';
import EmptyStateCard from './EmptyStateCard';
import {
  IconSearch, IconX, IconMail, IconMessageSquare, IconImage,
  IconUser, IconChevronRight,
} from './Icons';

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

function Section({ title, children, colors, icon: Icon }) {
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
        {Icon && <Icon size={14} color={colors?.textSecondary} />}
        <Text style={{ fontSize: 11, fontWeight: '700', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

function Row({ leading, title, subtitle, onPress, colors, query }) {
  const titleStyle = { fontSize: 14.5, fontWeight: '500', color: colors?.text };
  const subtitleStyle = { fontSize: 12, color: colors?.textSecondary, marginTop: 2 };
  const highlightColor = colors?.primary || '#7C3AED';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <HighlightText text={title} highlight={query} style={titleStyle} highlightColor={highlightColor} />
        {!!subtitle && (
          <HighlightText text={subtitle} highlight={query} style={subtitleStyle} highlightColor={highlightColor} />
        )}
      </View>
      <IconChevronRight size={16} color={colors?.textTertiary} />
    </TouchableOpacity>
  );
}

// Filter chips (WhatsApp pattern) — purely client-side post-processing.
// Keys are stable internal IDs; labels stay PT (per "no new i18n keys").
const FILTERS = [
  { id: 'all',    label: 'Tudo' },
  { id: 'msg',    label: 'Mensagens' },
  { id: 'media',  label: 'Mídia' },
  { id: 'links',  label: 'Links' },
  { id: 'docs',   label: 'Documentos' },
  { id: 'audio',  label: 'Áudio' },
  { id: 'people', label: 'Pessoas' },
  { id: 'convs',  label: 'Conversas' },
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
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  // Cache results per (filter,query) so toggling chips doesn't refetch when
  // the underlying unified payload is the same. The unified search payload
  // itself is the same regardless of filter (we filter client-side), so this
  // cache is keyed by query alone — the filter purely re-derives.
  const cacheRef = useRef(new Map());

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

  const go = (path) => { close(); setTimeout(() => router?.push(path), 60); };

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
          {/* Search bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border }}>
            <IconSearch size={18} color={colors?.textSecondary} />
            <TextInput
              ref={inputRef}
              value={q}
              onChangeText={setQ}
              placeholder={t?.('search.placeholder') || 'Buscar emails, chats, pessoas...'}
              placeholderTextColor={colors?.textTertiary}
              style={{ flex: 1, fontSize: 15, color: colors?.text, paddingVertical: 6 }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {loading && <ActivityIndicator size="small" color="#7C3AED" />}
            <TouchableOpacity onPress={close}>
              <IconX size={20} color={colors?.textSecondary} />
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
            {q.trim().length < 2 && (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ color: colors?.textSecondary, fontSize: 13 }}>
                  {t?.('search.hint') || 'Digite pelo menos 2 caracteres'}
                </Text>
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

            {/* Users */}
            {viewResults.users.length > 0 && (
              <Section title={t?.('search.users') || 'Pessoas'} icon={IconUser} colors={colors}>
                {viewResults.users.map(u => (
                  <Row
                    key={u.email}
                    leading={<AvatarCircle email={u.email} name={u.name} size={36} />}
                    title={u.name || u.email}
                    subtitle={u.email}
                    onPress={() => go(`/u/${encodeURIComponent(u.email)}`)}
                    colors={colors}
                    query={q.trim()}
                  />
                ))}
              </Section>
            )}

            {/* Chats */}
            {viewResults.chats.length > 0 && (
              <Section title={t?.('search.chats') || 'Conversas'} icon={IconMessageSquare} colors={colors}>
                {viewResults.chats.map(c => (
                  <Row
                    key={c.id}
                    leading={<AvatarCircle name={c.name || String(c.id)} size={36} />}
                    title={c.name || (t?.('chat.untitled') || 'Conversa')}
                    subtitle={c.type === 'group' ? (t?.('chat.group') || 'Grupo') : (t?.('chat.direct') || 'Direct')}
                    onPress={() => go(`/chat-conversation?id=${c.id}`)}
                    colors={colors}
                    query={q.trim()}
                  />
                ))}
              </Section>
            )}

            {/* Emails */}
            {viewResults.emails.length > 0 && (
              <Section title={t?.('search.emails') || 'Emails'} icon={IconMail} colors={colors}>
                {viewResults.emails.map((e, i) => (
                  <Row
                    key={`${e.folder}:${e.uid}:${i}`}
                    leading={
                      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors?.surface, alignItems: 'center', justifyContent: 'center' }}>
                        <IconMail size={16} color={colors?.text} />
                      </View>
                    }
                    title={e.subject}
                    subtitle={e.from}
                    onPress={() => go(`/read?uid=${e.uid}&folder=${encodeURIComponent(e.folder)}`)}
                    colors={colors}
                    query={q.trim()}
                  />
                ))}
              </Section>
            )}

            {/* Posts */}
            {viewResults.posts.length > 0 && (
              <Section title={t?.('search.posts') || 'Publicações'} icon={IconImage} colors={colors}>
                {viewResults.posts.map(p => {
                  const thumbUrl = resolveMedia(p.thumbnail);
                  return (
                    <Row
                      key={p.id}
                      leading={
                        thumbUrl ? (
                          WEB
                            ? <img src={thumbUrl} style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }} alt="" />
                            : <CachedImage source={{ uri: thumbUrl }} style={{ width: 36, height: 36, borderRadius: 6 }} resizeMode="cover" />
                        ) : (
                          <View style={{ width: 36, height: 36, borderRadius: 6, backgroundColor: colors?.surface }} />
                        )
                      }
                      title={p.caption || (t?.('feed.untitled') || 'Post')}
                      subtitle={p.author_email}
                      onPress={() => go(`/feed/${p.id}`)}
                      colors={colors}
                      query={q.trim()}
                    />
                  );
                })}
              </Section>
            )}
            <View style={{ height: 16 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
