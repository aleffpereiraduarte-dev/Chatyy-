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

function Row({ leading, title, subtitle, onPress, colors }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14.5, fontWeight: '500', color: colors?.text }} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }} numberOfLines={1}>{subtitle}</Text>}
      </View>
      <IconChevronRight size={16} color={colors?.textTertiary} />
    </TouchableOpacity>
  );
}

export default function GlobalSearch({
  visible, onClose, colors, isDark, t, router,
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState({ users: [], chats: [], emails: [], posts: [] });
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Autofocus when the overlay opens
  useEffect(() => {
    if (visible) {
      const h = setTimeout(() => { inputRef.current?.focus?.(); }, 140);
      return () => clearTimeout(h);
    } else {
      setQ('');
      setResults({ users: [], chats: [], emails: [], posts: [] });
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
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.searchGlobal(term);
        // Defensive defaults — server pode omitir buckets vazios e os
        // .length acessados depois quebrariam.
        if (r?.success) {
          setResults({
            users: r.data?.users || [],
            chats: r.data?.chats || [],
            emails: r.data?.emails || [],
            posts: r.data?.posts || [],
          });
        }
      } catch {}
      setLoading(false);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q]);

  const close = useCallback(() => {
    Keyboard.dismiss?.();
    onClose?.();
  }, [onClose]);

  const go = (path) => { close(); setTimeout(() => router?.push(path), 60); };

  const hasAny = (results.users?.length ?? 0) + (results.chats?.length ?? 0) + (results.emails?.length ?? 0) + (results.posts?.length ?? 0) > 0;

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

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {q.trim().length < 2 && (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ color: colors?.textSecondary, fontSize: 13 }}>
                  {t?.('search.hint') || 'Digite pelo menos 2 caracteres'}
                </Text>
              </View>
            )}

            {q.trim().length >= 2 && !loading && !hasAny && (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ color: colors?.textSecondary, fontSize: 13 }}>
                  {t?.('search.empty') || 'Nenhum resultado encontrado'}
                </Text>
              </View>
            )}

            {/* Users */}
            {results.users.length > 0 && (
              <Section title={t?.('search.users') || 'Pessoas'} icon={IconUser} colors={colors}>
                {results.users.map(u => (
                  <Row
                    key={u.email}
                    leading={<AvatarCircle email={u.email} name={u.name} size={36} />}
                    title={u.name || u.email}
                    subtitle={u.email}
                    onPress={() => go(`/u/${encodeURIComponent(u.email)}`)}
                    colors={colors}
                  />
                ))}
              </Section>
            )}

            {/* Chats */}
            {results.chats.length > 0 && (
              <Section title={t?.('search.chats') || 'Conversas'} icon={IconMessageSquare} colors={colors}>
                {results.chats.map(c => (
                  <Row
                    key={c.id}
                    leading={<AvatarCircle name={c.name || String(c.id)} size={36} />}
                    title={c.name || (t?.('chat.untitled') || 'Conversa')}
                    subtitle={c.type === 'group' ? (t?.('chat.group') || 'Grupo') : (t?.('chat.direct') || 'Direct')}
                    onPress={() => go(`/chat-conversation?id=${c.id}`)}
                    colors={colors}
                  />
                ))}
              </Section>
            )}

            {/* Emails */}
            {results.emails.length > 0 && (
              <Section title={t?.('search.emails') || 'Emails'} icon={IconMail} colors={colors}>
                {results.emails.map((e, i) => (
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
                  />
                ))}
              </Section>
            )}

            {/* Posts */}
            {results.posts.length > 0 && (
              <Section title={t?.('search.posts') || 'Publicações'} icon={IconImage} colors={colors}>
                {results.posts.map(p => {
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
