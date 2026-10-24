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
  ActivityIndicator, Dimensions, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext'; // [2026-10-10 feed-polish] i18n
import * as api from '../../services/api';
import AvatarCircle from '../../components/AvatarCircle';
import { IconHeart, IconMessageSquare, IconShare, IconX, IconMapPin, IconDownload, IconChevronLeft, IconArrowLeft, IconUser } from '../../components/Icons';
import { taggedPeople, tagRemove } from '../../services/videoStudio/studioApi'; // [2026-10-24 reels-marcar]
import { cachedVideoSource } from '../../services/videoCacheSource';

// [2026-10-17 notif-audit] Lazy: FeedComments pulls the comment stack — only
// logged-in viewers (notification taps) need it.
let _FeedComments = null;
function _loadFeedComments() {
  if (_FeedComments === null) { try { _FeedComments = require('../../components/FeedComments').default || false; } catch { _FeedComments = false; } }
  return _FeedComments;
}

// Native in-app video (was a "Vídeo — abra no app" placeholder even INSIDE the app).
let _ExpoVideo = null;
function _loadExpoVideo() {
  if (_ExpoVideo !== null) return _ExpoVideo;
  if (Platform.OS === 'web') { _ExpoVideo = false; return false; }
  try { _ExpoVideo = require('expo-video'); } catch { _ExpoVideo = false; }
  return _ExpoVideo;
}
function NativePostVideo({ uri }) {
  const mod = _loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) return null;
  const { useVideoPlayer, VideoView } = mod;
  const player = useVideoPlayer(cachedVideoSource(uri), (p) => {
    try { p.loop = true; p.muted = false; p.play(); } catch {}
  });
  return <VideoView player={player} style={{ width: '100%', height: '100%' }} contentFit="contain" nativeControls allowsFullscreen />;
}

const { width: SCREEN_W } = Dimensions.get('window');

// [perfil-publicar 2026-10-19] Carrossel (até 10 fotos/vídeos): deslizar + pontos +
// 1/N; só o vídeo visível monta player.
function PostCarousel({ urls, postIsVideo }) {
  const [idx, setIdx] = useState(0);
  const [w, setW] = useState(SCREEN_W);
  const list = urls.map(resolveMediaUrl).filter(Boolean);
  const isVid = (u, i) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u) || (postIsVideo && i === 0 && !/\.(jpe?g|png|webp|gif|heic)(\?|$)/i.test(u));
  return (
    <View style={{ width: '100%', backgroundColor: '#000', aspectRatio: 1 }} onLayout={(e) => setW(e.nativeEvent.layout.width || SCREEN_W)}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setIdx(Math.max(0, Math.round(e.nativeEvent.contentOffset.x / (w || 1))))}
        onScroll={Platform.OS === 'web' ? (e) => setIdx(Math.max(0, Math.round(e.nativeEvent.contentOffset.x / (w || 1)))) : undefined}
        scrollEventThrottle={64}
      >
        {list.map((u, i) => (
          <View key={`${i}:${u}`} style={{ width: w, height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            {isVid(u, i) ? (
              Platform.OS === 'web'
                ? <video src={u} controls playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
                : (i === idx && _loadExpoVideo() ? <NativePostVideo uri={u} /> : <IconPlayBig />)
            ) : (
              <Image source={{ uri: u }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
            )}
          </View>
        ))}
      </ScrollView>
      <View pointerEvents="none" style={{ position: 'absolute', top: 12, right: 12, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 11, paddingHorizontal: 9, paddingVertical: 3 }}>
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{`${idx + 1}/${list.length}`}</Text>
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', bottom: 10, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 }}>
        {list.map((_, i) => <View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === idx ? '#fff' : 'rgba(255,255,255,0.4)' }} />)}
      </View>
    </View>
  );
}
function IconPlayBig() {
  return (
    <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 0, height: 0, marginLeft: 5, borderTopWidth: 12, borderBottomWidth: 12, borderLeftWidth: 20, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: '#fff' }} />
    </View>
  );
}

function resolveMediaUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/data/')) return 'https://media.chatyy.com.br' + u;
  return u;
}

export default function FeedPostPublic() {
  const { id, comments } = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  // [2026-10-17 notif-audit] error is a KIND ('removed' | 'network'), never the
  // raw server string (the screen showed "Post not found" in English).
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showComments, setShowComments] = useState(false);
  const autoCommentsRef = useRef(false);
  const videoRef = useRef(null);
  const postId = String(Array.isArray(id) ? id[0] : (id || '')).replace(/[^0-9]/g, '');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      if (!postId) { if (alive) { setError('removed'); setLoading(false); } return; }
      // Public endpoint — auth header optional. apiCall will still attach
      // a Bearer if available so logged-in viewers get viewer-specific
      // flags (already_liked etc.) when the backend adds them.
      // A 404 right after the post was created (push "X publicou") can be a
      // replica that has not caught up yet → one quiet retry before "removed".
      let kind = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await api.apiCall('feed_get_post', { id: postId }, 'POST');
          if (!alive) return;
          if (r?.success && r.data?.post) { setPost(r.data.post); kind = null; break; }
          const msg = String(r?.message || r?.error || '');
          kind = /not.?found|n[aã]o encontrad|required/i.test(msg) ? 'removed'
            : (!r || /tempo limite|timeout|connection|offline|network|load failed/i.test(msg)) ? 'network'
            : (r.success === false ? 'removed' : 'network');
        } catch (e) {
          if (!alive) return;
          const st = Number(e?.status || e?.response?.status || 0);
          kind = st === 404 ? 'removed' : 'network';
        }
        if (attempt === 0) await new Promise((res) => setTimeout(res, 1200));
        if (!alive) return;
      }
      if (alive) { if (kind) setError(kind); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [postId, reloadKey]);

  // Comment notification → open the comment sheet once the post is loaded.
  useEffect(() => {
    if (!post || autoCommentsRef.current || !user?.email) return;
    if (comments === '1' || comments === 'true') { autoCommentsRef.current = true; setShowComments(true); }
  }, [post, comments, user?.email]);
  // Meta tags for social previews (web only). Without these, WhatsApp/
  // Twitter/Facebook show the generic Chatyy card instead of the post's
  // thumbnail. The Expo Router lets us mutate document.title; OG meta is
  // injected into the document head.
  useEffect(() => {
    if (Platform.OS !== 'web' || !post) return;
    try {
      const title = t('feedPublic.onChatyy').replace('{name}', post.author_name || post.author_email?.split('@')[0] || '');
      const desc = (post.caption || t('feedPublic.tagline')).slice(0, 160);
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

  const goLogin = () => router.push({ pathname: '/login', params: { next: `/feed/${postId}` } });
  const goApp = () => {
    if (user?.email) router.replace('/chat');
    else goLogin();
  };
  // [2026-10-17 notif-audit] Opened from a notification / deep link the stack
  // can be just this screen → "back" must still lead somewhere (home).
  const goBack = () => {
    try {
      if (typeof router.canGoBack === 'function' && router.canGoBack()) { router.back(); return; }
    } catch {}
    goApp();
  };
  const showBack = !!user?.email || (typeof router.canGoBack === 'function' && router.canGoBack());
  const BackBtn = showBack ? (
    <TouchableOpacity
      onPress={goBack}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={t('feedPublic.back')}
      style={styles.backBtn}
    >
      {Platform.OS === 'ios' ? <IconChevronLeft size={28} color={colors.text} /> : <IconArrowLeft size={24} color={colors.text} />}
    </TouchableOpacity>
  ) : null;

  if (loading) {
    return (
      <View style={[styles.wrap, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        {BackBtn ? <View style={styles.bareHeader}>{BackBtn}</View> : null}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  if (error || !post) {
    const isNet = error === 'network';
    return (
      <View style={[styles.wrap, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        {BackBtn ? <View style={styles.bareHeader}>{BackBtn}</View> : null}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' }}>
            {isNet ? t('feedPublic.loadErrorTitle') : t('feedPublic.removedTitle')}
          </Text>
          <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 20 }}>
            {isNet ? t('feedPublic.loadErrorBody') : t('feedPublic.removedBody')}
          </Text>
          {isNet ? (
            <TouchableOpacity onPress={() => setReloadKey((k) => k + 1)} style={{ marginTop: 24, paddingHorizontal: 24, paddingVertical: 12, backgroundColor: colors.primary, borderRadius: 10 }}>
              <Text style={{ color: colors.onPrimary, fontWeight: '700' }}>{t('feedPublic.retry')}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={showBack ? goBack : goApp} style={{ marginTop: isNet ? 12 : 24, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, ...(isNet ? { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border } : { backgroundColor: colors.primary }) }}>
            <Text style={{ color: isNet ? colors.text : colors.onPrimary, fontWeight: '700' }}>{showBack ? t('feedPublic.back') : t('feedPublic.goApp')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const media = post.media_urls?.[0] ? resolveMediaUrl(post.media_urls[0]) : null;
  const isVideo = post.media_type === 'video' || (media && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(media));
  const thumb = resolveMediaUrl(post.thumbnail_url) || media;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
    <ScrollView style={[styles.wrap, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 48, paddingTop: Platform.OS === 'web' ? 0 : insets.top }}>
      {/* Top bar */}
      <View style={[styles.topbar, { borderBottomColor: colors.border }]}>
        {BackBtn}
        <TouchableOpacity onPress={goApp} style={[styles.brandRow, { flex: 1 }]} activeOpacity={0.8}>
          <Text style={[styles.brand, { color: colors.primary }]}>Chatyy</Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginLeft: 8 }}>{t('feedPublic.tagline')}</Text>
        </TouchableOpacity>
        {!user?.email && (
          <TouchableOpacity onPress={goLogin} style={[styles.loginBtn, { backgroundColor: colors.primary }]} activeOpacity={0.85}>
            <Text style={[styles.loginBtnText, { color: colors.onPrimary }]}>{t('feedPublic.signIn')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Author */}
      <View style={styles.authorRow}>
        <AvatarCircle email={post.author_email} name={post.author_name} size={44} />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text style={[styles.authorName, { color: colors.text }]}>{post.author_name || post.author_email?.split('@')[0]}</Text>
          {!!post.location && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <IconMapPin size={12} color={colors.textSecondary} />
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{post.location}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Media — [perfil-publicar 2026-10-19] carrossel quando o post tem várias mídias */}
      {Array.isArray(post.media_urls) && post.media_urls.length > 1 ? (
        <PostCarousel urls={post.media_urls} postIsVideo={post.media_type === 'video'} />
      ) : media && (
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
              _loadExpoVideo() ? <NativePostVideo uri={media} /> : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#fff' }}>{t('feedPublic.videoOpenApp')}</Text>
                </View>
              )
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
        {/* [2026-10-24 reels-marcar] "com @fulano" + quem foi marcado pode se tirar (a notificação "marcou você" abre aqui). */}
        {(() => {
          const ppl = taggedPeople(post);
          if (!ppl.length) return null;
          const me = String(user?.email || '').toLowerCase();
          const amTagged = !!me && ppl.some((p) => p.email === me);
          const untag = () => Alert.alert(t('reels.tag.removeMe'), t('reels.tag.removeBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('reels.tag.removeConfirm'), style: 'destructive', onPress: async () => {
              const r = await tagRemove(post.id).catch(() => null);
              if (r && r.ok) setPost((p) => ({ ...p, tagged: r.tagged, tagged_users: r.tagged_users }));
              else Alert.alert(t('reels.tag.removeMe'), t('reels.tag.removeFailed'));
            } },
          ]);
          return (
            <View style={{ marginTop: 10, gap: 8 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <IconUser size={13} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{t('feed.with')}</Text>
                {ppl.map((p) => (
                  <TouchableOpacity key={p.email} onPress={() => { if (user?.email) router.push(`/u/${encodeURIComponent(p.email)}`); }} accessibilityRole="link" hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>{`@${p.handle}`}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {amTagged && (
                <TouchableOpacity onPress={untag} style={{ alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }} accessibilityRole="button">
                  <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{t('reels.tag.removeMe')}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })()}
        <View style={{ flexDirection: 'row', gap: 20, marginTop: 14, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconHeart size={18} color="#e11d48" />
            <Text style={{ color: colors.text, fontWeight: '600' }}>{post.likes_count || 0}</Text>
          </View>
          <TouchableOpacity
            disabled={!user?.email}
            onPress={() => setShowComments(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <IconMessageSquare size={18} color={colors.textSecondary} />
            <Text style={{ color: colors.text, fontWeight: '600' }}>{post.comments_count || 0}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* CTA for logged-out viewers */}
      {!user?.email && (
        <View style={[styles.cta, { borderColor: colors.border }]}>
          <Text style={[styles.ctaTitle, { color: colors.text }]}>{t('feedPublic.ctaTitle')}</Text>
          <Text style={[styles.ctaSubtitle, { color: colors.textSecondary }]}>
            {t('feedPublic.ctaSub').replace('{name}', post.author_name || t('feedPublic.theAuthor'))}
          </Text>
          <TouchableOpacity onPress={goLogin} style={[styles.ctaBtn, { backgroundColor: colors.primary }]} activeOpacity={0.85}>
            <Text style={[styles.ctaBtnText, { color: colors.onPrimary }]}>{t('feedPublic.signInChatyy')}</Text>
          </TouchableOpacity>
          {Platform.OS === 'web' && (
            <View style={styles.storesRow}>
              <TouchableOpacity
                onPress={() => (typeof window !== 'undefined') && window.open('https://apps.apple.com/app/id6759975575', '_blank')}
                style={[styles.storeBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.85}
                accessibilityLabel={t('feedPublic.downloadAppStore')}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <IconDownload size={14} color={colors.onPrimary} />
                  <Text style={[styles.storeText, { color: colors.onPrimary }]}>App Store</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => (typeof window !== 'undefined') && window.open('https://play.google.com/store/apps/details?id=com.onemundo.mail', '_blank')}
                style={[styles.storeBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.85}
                accessibilityLabel={t('feedPublic.getGooglePlay')}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <IconDownload size={14} color={colors.onPrimary} />
                  <Text style={[styles.storeText, { color: colors.onPrimary }]}>Google Play</Text>
                </View>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </ScrollView>
    {user?.email && showComments && _loadFeedComments() ? (() => {
      const FeedComments = _loadFeedComments();
      return (
        <FeedComments
          visible={showComments}
          post={post}
          colors={colors}
          isDark={isDark}
          t={t}
          user={user}
          onClose={() => setShowComments(false)}
          onCommentCountChange={(n) => { if (typeof n === 'number') setPost((p) => (p ? { ...p, comments_count: n } : p)); }}
        />
      );
    })() : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brandRow: { flexDirection: 'row', alignItems: 'baseline' },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginLeft: -8, marginRight: 4 },
  bareHeader: { height: 52, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
  brand: { fontSize: 20, fontWeight: '800', letterSpacing: 0.3 },
  loginBtn: { paddingHorizontal: 18, paddingVertical: 8, backgroundColor: '#111111', borderRadius: 8 },
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
    backgroundColor: '#111111', borderRadius: 10,
  },
  ctaBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  storesRow: { flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap', justifyContent: 'center' },
  storeBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  storeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
