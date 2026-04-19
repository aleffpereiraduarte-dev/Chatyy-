// Public shareable post view — works for logged-out viewers.
// URL: https://chatyy.com.br/feed/:id
//
// Unauthenticated users see the media + caption + like/comment counts,
// and a "Sign in to Chatyy" CTA. Logged-in users see the same layout
// plus interactive like/comment controls. Keeping this screen stand-alone
// (instead of reusing FeedPost) avoids pulling the whole chat auth stack
// into the anonymous render path — the public open graph preview depends
// on this page rendering fast even without a session.

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet, Platform, ScrollView,
  ActivityIndicator, Dimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../services/api';
import AvatarCircle from '../../components/AvatarCircle';
import { IconHeart, IconMessageSquare, IconShare, IconX } from '../../components/Icons';

const { width: SCREEN_W } = Dimensions.get('window');

function resolveMediaUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/data/')) return 'https://media.chatyy.com.br' + u;
  return u;
}

export default function FeedPostPublic() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Public endpoint — auth header optional. apiCall will still attach
        // a Bearer if available so logged-in viewers get viewer-specific
        // flags (already_liked etc.) when the backend adds them.
        const r = await api.apiCall('feed_get_post', { id }, 'POST');
        if (!alive) return;
        if (r?.success && r.data?.post) setPost(r.data.post);
        else setError(r?.message || 'Post não encontrado');
      } catch (e) {
        if (alive) setError(e?.message || 'Erro ao carregar');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  // Meta tags for social previews (web only). Without these, WhatsApp/
  // Twitter/Facebook show the generic Chatyy card instead of the post's
  // thumbnail. The Expo Router lets us mutate document.title; OG meta is
  // injected into the document head.
  useEffect(() => {
    if (Platform.OS !== 'web' || !post) return;
    try {
      const title = `${post.author_name || post.author_email?.split('@')[0]} no Chatyy`;
      const desc = (post.caption || 'Tudo está aqui').slice(0, 160);
      const imgRaw = post.thumbnail_url && !post.thumbnail_url.endsWith('.mp4')
        ? post.thumbnail_url
        : (post.media_urls && post.media_urls[0]);
      const img = resolveMediaUrl(imgRaw);
      document.title = title;
      const setMeta = (selector, attr, value) => {
        let el = document.querySelector(selector);
        if (!el) {
          el = document.createElement('meta');
          const parts = selector.match(/meta\[([^=]+)="([^"]+)"\]/);
          if (parts) el.setAttribute(parts[1], parts[2]);
          document.head.appendChild(el);
        }
        el.setAttribute(attr, value);
      };
      setMeta('meta[property="og:title"]', 'content', title);
      setMeta('meta[property="og:description"]', 'content', desc);
      setMeta('meta[property="og:image"]', 'content', img);
      setMeta('meta[property="og:url"]', 'content', typeof window !== 'undefined' ? window.location.href : '');
      setMeta('meta[property="og:type"]', 'content', post.media_type === 'video' ? 'video.other' : 'article');
      setMeta('meta[name="twitter:card"]', 'content', 'summary_large_image');
      setMeta('meta[name="twitter:title"]', 'content', title);
      setMeta('meta[name="twitter:description"]', 'content', desc);
      setMeta('meta[name="twitter:image"]', 'content', img);
    } catch {}
  }, [post]);

  const goLogin = () => router.push({ pathname: '/login', params: { next: `/feed/${id}` } });
  const goApp = () => {
    if (user?.email) router.replace('/inbox');
    else goLogin();
  };

  if (loading) {
    return (
      <View style={[styles.wrap, { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  if (error || !post) {
    return (
      <View style={[styles.wrap, { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Post não disponível</Text>
        <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 8, textAlign: 'center' }}>{error || 'Este post foi removido ou não pode ser exibido.'}</Text>
        <TouchableOpacity onPress={goApp} style={{ marginTop: 24, paddingHorizontal: 24, paddingVertical: 12, backgroundColor: '#7C3AED', borderRadius: 10 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Ir pro Chatyy</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const media = post.media_urls?.[0] ? resolveMediaUrl(post.media_urls[0]) : null;
  const isVideo = post.media_type === 'video' || (media && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(media));
  const thumb = resolveMediaUrl(post.thumbnail_url) || media;

  return (
    <ScrollView style={[styles.wrap, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 48 }}>
      {/* Top bar */}
      <View style={[styles.topbar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={goApp} style={styles.brandRow} activeOpacity={0.8}>
          <Text style={[styles.brand, { color: '#7C3AED' }]}>Chatyy</Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginLeft: 8 }}>Tudo está aqui</Text>
        </TouchableOpacity>
        {!user?.email && (
          <TouchableOpacity onPress={goLogin} style={styles.loginBtn} activeOpacity={0.85}>
            <Text style={styles.loginBtnText}>Entrar</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Author */}
      <View style={styles.authorRow}>
        <AvatarCircle email={post.author_email} name={post.author_name} size={44} />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text style={[styles.authorName, { color: colors.text }]}>{post.author_name || post.author_email?.split('@')[0]}</Text>
          {!!post.location && (
            <Text style={{ fontSize: 12, color: colors.textSecondary }}>📍 {post.location}</Text>
          )}
        </View>
      </View>

      {/* Media */}
      {media && (
        <View style={{ width: '100%', backgroundColor: '#000', aspectRatio: 1 }}>
          {isVideo ? (
            Platform.OS === 'web' ? (
              <video
                ref={videoRef}
                src={media}
                poster={thumb !== media ? thumb : undefined}
                controls
                playsInline
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
              />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff' }}>Vídeo — abra no app</Text>
              </View>
            )
          ) : (
            <Image source={{ uri: media }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          )}
        </View>
      )}

      {/* Caption + counts */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
        {!!post.caption && (
          <Text style={[styles.caption, { color: colors.text }]}>{post.caption}</Text>
        )}
        <View style={{ flexDirection: 'row', gap: 20, marginTop: 14, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconHeart size={18} color="#e11d48" />
            <Text style={{ color: colors.text, fontWeight: '600' }}>{post.likes_count || 0}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconMessageSquare size={18} color={colors.textSecondary} />
            <Text style={{ color: colors.text, fontWeight: '600' }}>{post.comments_count || 0}</Text>
          </View>
        </View>
      </View>

      {/* CTA for logged-out viewers */}
      {!user?.email && (
        <View style={[styles.cta, { borderColor: colors.border }]}>
          <Text style={[styles.ctaTitle, { color: colors.text }]}>Gostou desse post?</Text>
          <Text style={[styles.ctaSubtitle, { color: colors.textSecondary }]}>
            Entre pra curtir, comentar e seguir {post.author_name || 'o autor'}.
          </Text>
          <TouchableOpacity onPress={goLogin} style={styles.ctaBtn} activeOpacity={0.85}>
            <Text style={styles.ctaBtnText}>Entrar no Chatyy</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brandRow: { flexDirection: 'row', alignItems: 'baseline' },
  brand: { fontSize: 20, fontWeight: '800', letterSpacing: 0.3 },
  loginBtn: { paddingHorizontal: 18, paddingVertical: 8, backgroundColor: '#7C3AED', borderRadius: 8 },
  loginBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  authorRow: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  authorName: { fontSize: 15, fontWeight: '700' },
  caption: { fontSize: 15, lineHeight: 21 },
  cta: {
    margin: 16, padding: 20, borderWidth: 1, borderRadius: 14,
    alignItems: 'center',
  },
  ctaTitle: { fontSize: 17, fontWeight: '700' },
  ctaSubtitle: { fontSize: 13, marginTop: 6, textAlign: 'center' },
  ctaBtn: {
    marginTop: 14, paddingHorizontal: 28, paddingVertical: 12,
    backgroundColor: '#7C3AED', borderRadius: 10,
  },
  ctaBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
