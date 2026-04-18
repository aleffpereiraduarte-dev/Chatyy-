import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, Dimensions, ScrollView, Animated, TextInput,
  Image, Modal,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import AvatarCircle, { bumpAvatarCache } from './AvatarCircle';
import FeedPost from './FeedPost';
import FeedComments from './FeedComments';
import CreatePostModal from './CreatePostModal';
import LiveIndicator from './LiveIndicator';
import ReelsViewer from './ReelsViewer';
import { IconPlus, IconVideo, IconSearch, IconX, IconBell } from './Icons';
import Svg, { Circle, Rect, Path, Line, Polyline } from 'react-native-svg';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

const ACCENT = '#7C3AED';
const SCREEN_WIDTH = Dimensions.get('window').width;
const useNative = Platform.OS !== 'web';

// ── MMKV synchronous preload (native only) for instant first paint ──
let _preloadedFeedPosts = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_feed');
    if (raw) _preloadedFeedPosts = JSON.parse(raw);
  } catch {}
}
const _saveFeedToMMKV = (posts) => {
  if (Platform.OS === 'web') return;
  try {
    const { setString: _ss } = require('../services/mmkv');
    _ss('chat_feed', JSON.stringify(Array.isArray(posts) ? posts.slice(0, 100) : []));
  } catch {}
};

// Fingerprint of the feed list — id + likes_count + comments_count + updated_at.
// setState only when this changes, so unchanged polls don't cause re-renders.
const _feedFingerprint = (arr) => {
  if (!Array.isArray(arr)) return '';
  return arr.map(p =>
    `${p.id}:${p.likes_count ?? p.like_count ?? 0}:${p.comments_count ?? p.comment_count ?? 0}:${p.updated_at || p.created_at || ''}`
  ).join('|');
};

// Memoized row wrapper so prop-function-identity changes don't re-render every post.
const FeedPostRow = React.memo(function FeedPostRow(props) {
  return <FeedPost {...props} />;
}, (prev, next) => {
  if (prev.isDark !== next.isDark) return false;
  if (prev.colors !== next.colors) return false;
  if (prev.user?.email !== next.user?.email) return false;
  const a = prev.post, b = next.post;
  if (!a || !b) return a === b;
  if (a.id !== b.id) return false;
  if ((a.likes_count ?? a.like_count ?? 0) !== (b.likes_count ?? b.like_count ?? 0)) return false;
  if ((a.comments_count ?? a.comment_count ?? 0) !== (b.comments_count ?? b.comment_count ?? 0)) return false;
  if ((a.updated_at || '') !== (b.updated_at || '')) return false;
  if ((a.liked_by_me || false) !== (b.liked_by_me || false)) return false;
  if ((a.bookmarked_by_me || false) !== (b.bookmarked_by_me || false)) return false;
  if ((a.caption || '') !== (b.caption || '')) return false;
  // Ignore function reference changes (onOpenComments, onDeletePost, etc.)
  return true;
});

// ── Skeleton loader for feed posts ──
function FeedSkeleton({ isDark }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);
  const bg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return (
    <Animated.View style={{ opacity, padding: 16, gap: 12 }}>
      {[0, 1, 2].map(i => (
        <View key={i} style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff', borderRadius: 16, padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: bg }} />
            <View style={{ gap: 6, flex: 1 }}>
              <View style={{ width: '50%', height: 12, borderRadius: 6, backgroundColor: bg }} />
              <View style={{ width: '30%', height: 10, borderRadius: 5, backgroundColor: bg }} />
            </View>
          </View>
          <View style={{ width: '100%', height: 200, borderRadius: 12, backgroundColor: bg }} />
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <View style={{ width: 60, height: 10, borderRadius: 5, backgroundColor: bg }} />
            <View style={{ width: 60, height: 10, borderRadius: 5, backgroundColor: bg }} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

function EmptyFeedIllustration({ isDark }) {
  return (
    <Svg width={100} height={100} viewBox="0 0 100 100" fill="none">
      <Rect x="20" y="15" width="60" height="70" rx="8" stroke={isDark ? '#374151' : '#e5e7eb'} strokeWidth="2" fill="none" />
      <Rect x="28" y="25" width="44" height="30" rx="4" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" />
      <Circle cx="50" cy="37" r="6" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" />
      <Path d="M28 50 L38 42 L45 48 L55 38 L72 50" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      <Rect x="28" y="60" width="30" height="3" rx="1.5" fill={isDark ? '#374151' : '#e5e7eb'} />
      <Rect x="28" y="67" width="20" height="3" rx="1.5" fill={isDark ? '#374151' : '#e5e7eb'} />
      <Circle cx="70" cy="65" r="4" stroke={ACCENT} strokeWidth="1.5" fill="none" />
      <Path d="M68 65 L72 65" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" />
      <Path d="M70 63 L70 67" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  );
}

// ── Perfil Instagram-like (completo) ──
function ProfilePostGrid({ post, size, isDark, colors, onPress }) {
  const media = post.media?.[0] || {};
  const thumb = media.thumbnail_url || media.url || '';
  const isMulti = (post.media || []).length > 1;
  const isVideo = media.type === 'video';
  const [imgError, setImgError] = React.useState(false);
  const likes = post.likes_count || post.like_count || 0;
  const comments = post.comments_count || post.comment_count || 0;

  return (
    <TouchableOpacity onPress={() => onPress?.(post)} style={{ width: size, height: size, backgroundColor: isDark ? '#1a1a1a' : '#efefef' }} activeOpacity={0.85}>
      {thumb && !imgError ? (
        <Image source={{ uri: thumb }} style={{ width: size, height: size }} resizeMode="cover" onError={() => setImgError(true)} />
      ) : (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', padding: 8 }}>
          <Text style={{ color: colors.textTertiary, fontSize: 11, textAlign: 'center' }} numberOfLines={3}>
            {(post.caption || '').slice(0, 60) || ''}
          </Text>
        </View>
      )}
      {isVideo && (
        <View style={{ position: 'absolute', top: 6, right: 6 }}>
          <Svg width={18} height={18} viewBox="0 0 24 24" fill="#fff" stroke="none"><Path d="M8 5v14l11-7z" /></Svg>
        </View>
      )}
      {isMulti && !isVideo && (
        <View style={{ position: 'absolute', top: 6, right: 6 }}>
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.5}><Rect x="3" y="3" width="18" height="18" rx="2" /><Path d="M8 3v18" /></Svg>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Highlights circle (Instagram-style)
function HighlightCircle({ label, isDark, colors, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={{ alignItems: 'center', marginRight: 16 }}>
      <View style={{
        width: 64, height: 64, borderRadius: 32, borderWidth: 1.5,
        borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
        alignItems: 'center', justifyContent: 'center', marginBottom: 6,
        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
      }}>
        <IconPlus size={24} color={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.25)'} />
      </View>
      <Text style={{ fontSize: 11, color: colors.textSecondary, textAlign: 'center' }} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function FeedProfileSection({ colors, isDark, t, user, router, onCreatePost }) {
  const [stats, setStats] = useState({ posts: 0, followers: 0, following: 0 });
  const [myPosts, setMyPosts] = useState([]);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [profileTab, setProfileTab] = useState('grid'); // 'grid' | 'reels' | 'saved'
  const [profileData, setProfileData] = useState(null);
  const [savedPosts, setSavedPosts] = useState([]);
  const [editVisible, setEditVisible] = useState(false);

  useEffect(() => {
    if (!user?.email) return;
    let alive = true;
    Promise.all([
      api.feedList({ page: 1, limit: 50, author: user.email }),
      api.getProfile?.().catch(() => null),
      api.feedBookmarkList?.().catch(() => null),
    ]).then(([postsRes, profileRes, savedRes]) => {
      if (!alive) return;
      if (postsRes?.success && postsRes.data) {
        const postsList = Array.isArray(postsRes.data) ? postsRes.data : (postsRes.data.posts || []);
        setMyPosts(postsList);
        setStats(prev => ({ ...prev, posts: postsList.length }));
      }
      if (profileRes?.success && profileRes.data) setProfileData(profileRes.data);
      if (savedRes?.success && savedRes.data) {
        const saved = Array.isArray(savedRes.data) ? savedRes.data : (savedRes.data.posts || []);
        setSavedPosts(saved);
      }
      setLoadingProfile(false);
    });
    return () => { alive = false; };
  }, [user?.email]);

  const windowWidth = Dimensions.get('window').width;
  const postGridSize = Math.floor((windowWidth - 4) / 3);
  const fmtNum = (n) => n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  if (loadingProfile) {
    return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 }}><ActivityIndicator size="large" color={ACCENT} /></View>;
  }

  const displayName = profileData?.name || user?.name || user?.email?.split('@')[0] || '';
  const bio = profileData?.about || profileData?.bio || '';
  const username = profileData?.username || '';
  const activePosts = profileTab === 'saved' ? savedPosts : profileTab === 'reels' ? myPosts.filter(p => p.media?.[0]?.type === 'video') : myPosts;

  const openOwnProfile = () => {
    // Instagram-style self view, NOT the email account settings screen
    if (!user?.email) return;
    router?.push({ pathname: '/user-profile', params: { email: user.email, name: user.name || '' } });
  };
  const openEditFeedProfile = () => setEditVisible(true);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: isDark ? colors.background : '#fafafa' }} showsVerticalScrollIndicator={false}>
      {/* ── Cabecalho do perfil ── */}
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity activeOpacity={0.8} onPress={openOwnProfile}>
            <View style={{ borderWidth: 2.5, borderRadius: 48, padding: 3, borderColor: myPosts.length > 0 ? ACCENT : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)') }}>
              <AvatarCircle name={displayName} email={user?.email} size={82} />
            </View>
          </TouchableOpacity>
          <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-evenly', marginLeft: 16 }}>
            {[
              { value: stats.posts, label: t('feed.profilePosts') || 'Publicacoes' },
              { value: stats.followers, label: t('feed.profileFollowers') || 'Seguidores', tap: true },
              { value: stats.following, label: t('feed.profileFollowing') || 'Seguindo', tap: true },
            ].map((s, i) => (
              <TouchableOpacity key={i} style={{ alignItems: 'center' }}
                onPress={s.tap ? openOwnProfile : undefined} activeOpacity={s.tap ? 0.6 : 1}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>{fmtNum(s.value)}</Text>
                <Text style={{ fontSize: 11.5, color: colors.textSecondary, marginTop: 1 }}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Nome + username + bio */}
        <View style={{ marginTop: 12 }}>
          <Text style={{ fontSize: 14.5, fontWeight: '700', color: colors.text }}>{displayName}</Text>
          {username ? <Text style={{ fontSize: 13, color: ACCENT, marginTop: 1, fontWeight: '500' }}>@{username}</Text> : null}
          {bio ? <Text style={{ fontSize: 13.5, color: colors.text, marginTop: 4, lineHeight: 18 }}>{bio}</Text> : null}
        </View>

        {/* Botoes de acao */}
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 14 }}>
          <TouchableOpacity onPress={openEditFeedProfile} activeOpacity={0.7}
            style={{ flex: 1, paddingVertical: 7, borderRadius: 8, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{t('feed.editProfile') || 'Editar perfil'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onCreatePost} activeOpacity={0.7}
            style={{ flex: 1, paddingVertical: 7, borderRadius: 8, backgroundColor: ACCENT, alignItems: 'center',
              ...Platform.select({ ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6 }, android: { elevation: 3 }, web: { boxShadow: '0 2px 8px rgba(124,58,237,0.3)' } }) }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{t('feed.newPublication') || 'Nova publicacao'}</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.7}
            onPress={() => { try { require('react-native').Share.share({ message: `${t('feed.followMe') || 'Me siga no Chatyy'}: @${username || user?.email?.split('@')[0]}` }); } catch {} }}
            style={{ width: 34, paddingVertical: 7, borderRadius: 8, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)', alignItems: 'center', justifyContent: 'center' }}>
            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" /><Polyline points="16 6 12 2 8 6" /><Line x1="12" y1="2" x2="12" y2="15" />
            </Svg>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Destaques (highlights) ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ paddingLeft: 18, paddingVertical: 12 }}>
        <HighlightCircle label={t('feed.newHighlight') || 'Novo'} isDark={isDark} colors={colors} onPress={onCreatePost} />
      </ScrollView>

      {/* ── Tabs: Grade | Reels | Salvos ── */}
      <View style={{ flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}>
        {[
          { key: 'grid', icon: (active) => <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={active ? colors.text : colors.textTertiary} strokeWidth={1.8}><Rect x="3" y="3" width="7" height="7" /><Rect x="14" y="3" width="7" height="7" /><Rect x="3" y="14" width="7" height="7" /><Rect x="14" y="14" width="7" height="7" /></Svg> },
          { key: 'reels', icon: (active) => <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={active ? colors.text : colors.textTertiary} strokeWidth={1.8}><Rect x="2" y="2" width="20" height="20" rx="2" /><Line x1="2" y1="8" x2="22" y2="8" /><Line x1="8" y1="2" x2="8" y2="8" /><Path d="M10 12l5 3-5 3z" /></Svg> },
          { key: 'saved', icon: (active) => <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={active ? colors.text : colors.textTertiary} strokeWidth={1.8}><Path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" /></Svg> },
        ].map(tab => (
          <TouchableOpacity key={tab.key} onPress={() => setProfileTab(tab.key)} activeOpacity={0.7}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: profileTab === tab.key ? 2 : 0, borderBottomColor: colors.text }}>
            {tab.icon(profileTab === tab.key)}
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Grade de posts ── */}
      {activePosts.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}>
          {activePosts.map(post => (
            <ProfilePostGrid
              key={post.id}
              post={post}
              size={postGridSize}
              isDark={isDark}
              colors={colors}
              onPress={(p) => {
                // Opens the Instagram-style self profile which has a post viewer
                if (user?.email) router?.push({ pathname: '/user-profile', params: { email: user.email, name: user.name || '', postId: String(p.id || '') } });
              }}
            />
          ))}
        </View>
      ) : (
        <View style={{ alignItems: 'center', paddingTop: 50, paddingHorizontal: 40, paddingBottom: 40 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            {profileTab === 'saved' ? (
              <Svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)'} strokeWidth={1.5}><Path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" /></Svg>
            ) : profileTab === 'reels' ? (
              <Svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)'} strokeWidth={1.5}><Rect x="2" y="2" width="20" height="20" rx="2" /><Path d="M10 8l6 4-6 4z" /></Svg>
            ) : (
              <Svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)'} strokeWidth={1.5}><Rect x="3" y="3" width="18" height="18" rx="2" /><Circle cx="8.5" cy="8.5" r="1.5" /><Path d="M21 15l-5-5L5 21" /></Svg>
            )}
          </View>
          <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 6, letterSpacing: -0.3 }}>
            {profileTab === 'saved' ? (t('feed.noSaved') || 'Nenhum item salvo')
              : profileTab === 'reels' ? (t('feed.noReels') || 'Nenhum reel ainda')
              : (t('feed.noPhotos') || 'Compartilhe fotos')}
          </Text>
          <Text style={{ fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
            {profileTab === 'saved' ? (t('feed.noSavedHint') || 'Itens que voce salvar vao aparecer aqui.')
              : profileTab === 'reels' ? (t('feed.noReelsHint') || 'Grave e compartilhe seus primeiros reels.')
              : (t('feed.noPhotosHint') || 'Quando voce compartilhar fotos, elas vao aparecer no seu perfil.')}
          </Text>
          {profileTab === 'grid' && (
            <TouchableOpacity onPress={onCreatePost} style={{ marginTop: 16 }} activeOpacity={0.7}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: ACCENT }}>{t('feed.shareFirst') || 'Compartilhar primeira foto'}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      <View style={{ height: 80 }} />

      <FeedProfileEditModal
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        colors={colors}
        isDark={isDark}
        t={t}
        initialData={profileData || {}}
        user={user}
        onSaved={(updated) => {
          setProfileData(prev => ({ ...(prev || {}), ...updated }));
          setEditVisible(false);
        }}
      />
    </ScrollView>
  );
}

// ─── FeedProfileEditModal — Instagram-style profile editor (name, bio, username, link, avatar) ───
function FeedProfileEditModal({ visible, onClose, colors, isDark, t, initialData, user, onSaved }) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [link, setLink] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarCacheBust, setAvatarCacheBust] = useState(0);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!visible) return;
    setDisplayName(initialData?.name || initialData?.display_name || user?.name || '');
    setUsername(initialData?.username || user?.email?.split('@')[0] || '');
    setBio(initialData?.bio || initialData?.about || '');
    setLink(initialData?.website || initialData?.link || '');
    setErr('');
  }, [visible, initialData, user]);

  const handleChangeAvatar = async () => {
    setErr('');
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setUploadingAvatar(true);
          try {
            const r = await api.uploadAvatar(file);
            if (r?.success) { bumpAvatarCache(user?.email); setAvatarCacheBust(Date.now()); }
            else setErr(r?.message || (t('feed.avatarFailed') || 'Falha ao enviar avatar'));
          } catch (ex) { setErr(String(ex?.message || ex)); }
          setUploadingAvatar(false);
        };
        input.click();
      } else {
        const { launchImageLibraryAsync, MediaTypeOptions, requestMediaLibraryPermissionsAsync } = await import('expo-image-picker');
        const perm = await requestMediaLibraryPermissionsAsync();
        if (!perm?.granted) { setErr(t('feed.permissionDenied') || 'Permissão negada'); return; }
        const r = await launchImageLibraryAsync({ mediaTypes: MediaTypeOptions.Images, quality: 0.85, allowsEditing: true, aspect: [1, 1] });
        if (r.canceled || !r.assets?.[0]) return;
        const a = r.assets[0];
        setUploadingAvatar(true);
        const up = await api.uploadAvatar({
          uri: a.uri,
          name: a.fileName || 'avatar.jpg',
          type: a.mimeType || 'image/jpeg',
        });
        if (up?.success) { bumpAvatarCache(user?.email); setAvatarCacheBust(Date.now()); }
        else setErr(up?.message || (t('feed.avatarFailed') || 'Falha ao enviar avatar'));
        setUploadingAvatar(false);
      }
    } catch (ex) {
      setErr(String(ex?.message || ex));
      setUploadingAvatar(false);
    }
  };

  const handleSave = async () => {
    const cleanUser = (username || '').trim().toLowerCase().replace(/[^a-z0-9_.]/g, '');
    if (cleanUser && cleanUser.length < 3) { setErr(t('feed.usernameTooShort') || 'Username muito curto (min 3)'); return; }
    if (bio.length > 160) { setErr(t('feed.bioTooLong') || 'Bio max 160 caracteres'); return; }
    setSaving(true); setErr('');
    try {
      const payload = {
        name: displayName.trim() || undefined,
        username: cleanUser || undefined,
        bio: bio.trim(),
        website: link.trim() || undefined,
      };
      const r = await (api.updateProfile?.(payload) || api.profileUpdate?.(payload));
      if (r?.success === false) { setErr(r?.message || t('feed.saveFailed') || 'Falha ao salvar'); setSaving(false); return; }
      onSaved?.(payload);
    } catch (e) {
      setErr(String(e?.message || e));
    }
    setSaving(false);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: isDark ? '#121212' : '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, maxHeight: '92%' }}>
          {/* Grabber */}
          <View style={{ alignItems: 'center', marginBottom: 8 }}>
            <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={{ fontSize: 15, color: colors.text }}>{t('common.cancel') || 'Cancelar'}</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>{t('feed.editProfile') || 'Editar perfil'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={saving} activeOpacity={0.7}>
              <Text style={{ fontSize: 15, color: ACCENT, fontWeight: '700' }}>
                {saving ? (t('common.saving') || 'Salvando…') : (t('common.save') || 'Salvar')}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <TouchableOpacity onPress={handleChangeAvatar} disabled={uploadingAvatar} activeOpacity={0.7} style={{ alignItems: 'center', marginBottom: 18 }}>
              <AvatarCircle key={avatarCacheBust} name={displayName || user?.email} email={user?.email} size={90} />
              {uploadingAvatar ? (
                <ActivityIndicator size="small" color={ACCENT} style={{ marginTop: 8 }} />
              ) : (
                <Text style={{ fontSize: 13, color: ACCENT, marginTop: 8, fontWeight: '600' }}>
                  {t('feed.changePhoto') || 'Alterar foto do perfil'}
                </Text>
              )}
            </TouchableOpacity>

            {[
              { label: t('feed.name') || 'Nome', value: displayName, set: setDisplayName, placeholder: t('feed.namePlaceholder') || 'Seu nome', max: 60 },
              { label: t('feed.username') || 'Nome de usuário', value: username, set: setUsername, placeholder: 'usuario', max: 30, prefix: '@' },
              { label: t('feed.bio') || 'Bio', value: bio, set: setBio, placeholder: t('feed.bioPlaceholder') || 'Conte sobre você…', max: 160, multiline: true },
              { label: t('feed.link') || 'Link', value: link, set: setLink, placeholder: 'https://…', max: 200, autoCapitalize: 'none', keyboardType: 'url' },
            ].map((f, i) => (
              <View key={i} style={{ marginBottom: 14 }}>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4, letterSpacing: 0.3, textTransform: 'uppercase', fontWeight: '600' }}>{f.label}</Text>
                <View style={{ flexDirection: 'row', alignItems: f.multiline ? 'flex-start' : 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)', paddingBottom: 4 }}>
                  {f.prefix && <Text style={{ color: colors.textSecondary, marginRight: 4, fontSize: 15 }}>{f.prefix}</Text>}
                  <TextInput
                    value={f.value}
                    onChangeText={(v) => f.set((v || '').slice(0, f.max))}
                    placeholder={f.placeholder}
                    placeholderTextColor={isDark ? '#666' : '#999'}
                    style={{ flex: 1, color: colors.text, fontSize: 15, paddingVertical: 6, outlineStyle: 'none', minHeight: f.multiline ? 60 : undefined, textAlignVertical: f.multiline ? 'top' : 'center' }}
                    multiline={!!f.multiline}
                    autoCapitalize={f.autoCapitalize || 'sentences'}
                    autoCorrect={false}
                    keyboardType={f.keyboardType || 'default'}
                  />
                  {f.multiline && <Text style={{ color: colors.textSecondary, fontSize: 11, marginLeft: 6, marginTop: 6 }}>{f.value.length}/{f.max}</Text>}
                </View>
              </View>
            ))}

            {err ? <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 4, textAlign: 'center' }}>{err}</Text> : null}
            <View style={{ height: 24 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function ChatFeedTab({ colors, isDark, t, user, router }) {
  const [feedMode, setFeedMode] = useState('posts'); // 'posts' | 'reels' | 'profile'
  // Initial state reads from MMKV preload so the very first render already has data.
  const _initialPosts = Array.isArray(_preloadedFeedPosts) ? _preloadedFeedPosts : [];
  const [posts, setPosts] = useState(() => _initialPosts);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // Skip the skeleton if we already painted from cache.
  const [loading, setLoading] = useState(_initialPosts.length === 0);
  const lastFeedFpRef = useRef(_feedFingerprint(_initialPosts));
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [commentsPost, setCommentsPost] = useState(null);
  const [activeLives, setActiveLives] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [unreadNotifs, setUnreadNotifs] = useState(0);

  // Poll unread notification count every 45s (and once on mount)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.notificationsUnreadCount();
        if (alive && r?.success) setUnreadNotifs(Math.min(99, r.data?.count || 0));
      } catch {}
    };
    tick();
    const id = setInterval(tick, 45000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const pollRef = useRef(null);
  const livePollRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchRequestIdRef = useRef(0);

  const loadPosts = useCallback(async (pageNum = 1, isRefresh = false) => {
    // FAST PATH: if we already have posts on screen and this is a page-1 load,
    // skip the IndexedDB/async cache read entirely and go straight to silent
    // API delta sync — no flicker, no empty state.
    let alreadyHasVisible = false;
    if (pageNum === 1 && !isRefresh) {
      setPosts(prev => { alreadyHasVisible = (prev?.length || 0) > 0; return prev; });
    }

    // Only do the async cached read on a truly cold start.
    if (pageNum === 1 && !isRefresh && !alreadyHasVisible) {
      try {
        const cached = await getCached('feed_posts');
        if (cached && cached.length > 0) {
          const fp = _feedFingerprint(cached);
          if (fp !== lastFeedFpRef.current) {
            lastFeedFpRef.current = fp;
            setPosts(cached);
          }
          setLoading(false);
        }
      } catch {}
    }

    try {
      const r = await api.feedList(pageNum, 20);
      if (r && r.success && r.data) {
        const rawPosts = r.data.posts || r.data;
        const newPosts = Array.isArray(rawPosts) ? rawPosts : [];
        if (pageNum === 1 || isRefresh) {
          // Fingerprint compare — skip setState if nothing actually changed.
          const fp = _feedFingerprint(newPosts);
          if (fp !== lastFeedFpRef.current) {
            lastFeedFpRef.current = fp;
            setPosts(newPosts);
          }
          if (pageNum === 1) {
            setCache('feed_posts', newPosts, 7776000000).catch(() => {});
            _saveFeedToMMKV(newPosts);
          }
        } else {
          setPosts(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            const unique = newPosts.filter(p => !existingIds.has(p.id));
            if (unique.length === 0) return prev; // nothing new, keep reference
            const merged = [...prev, ...unique];
            lastFeedFpRef.current = _feedFingerprint(merged);
            return merged;
          });
        }
        setHasMore(newPosts.length >= 20);
      }
    } catch (e) {
      console.warn('Feed load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  // Load active lives
  const loadLives = useCallback(async () => {
    try {
      const r = await api.liveList();
      if (r && r.success && r.data?.sessions) {
        setActiveLives(Array.isArray(r.data.sessions) ? r.data.sessions : []);
      }
    } catch (e) {
      console.warn('Live list error:', e);
    }
  }, []);

  // ── User search with debounce ──
  const handleSearchChange = useCallback((text) => {
    setSearchQuery(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (text.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const reqId = ++searchRequestIdRef.current;
    searchTimerRef.current = setTimeout(async () => {
      try {
        const r = await api.searchUsers(text.trim());
        if (reqId !== searchRequestIdRef.current) return; // stale response
        if (r && r.success && r.data?.users) {
          setSearchResults(r.data.users);
        } else {
          setSearchResults([]);
        }
      } catch (e) {
        if (reqId !== searchRequestIdRef.current) return;
        console.warn('User search error:', e);
        setSearchResults([]);
      } finally {
        if (reqId === searchRequestIdRef.current) setSearchLoading(false);
      }
    }, 400);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setIsSearchActive(false);
    setSearchLoading(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  useEffect(() => {
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, []);

  // Initial load + WS real-time events with reduced polling fallback
  useEffect(() => {
    loadPosts(1);
    loadLives();

    // WebSocket: instant feed updates when someone posts
    let unsubFeed = null, unsubLiveStart = null, unsubLiveEnd = null;
    if (mailWs?.on) {
      unsubFeed = mailWs.on('feed_new_post', (data) => {
        if (data?.post) {
          setPosts(prev => {
            if (prev.some(p => p.id === data.post.id)) return prev;
            const next = [data.post, ...prev];
            lastFeedFpRef.current = _feedFingerprint(next);
            _saveFeedToMMKV(next);
            return next;
          });
        } else { loadPosts(1, true); }
      });
      unsubLiveStart = mailWs.on('live_started', () => loadLives());
      unsubLiveEnd = mailWs.on('live_ended', () => loadLives());
    }

    pollRef.current = setInterval(() => loadPosts(1, true), 60000);
    livePollRef.current = setInterval(loadLives, 60000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (livePollRef.current) clearInterval(livePollRef.current);
      unsubFeed?.(); unsubLiveStart?.(); unsubLiveEnd?.();
    };
  }, [loadPosts, loadLives]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
    loadPosts(1, true);
  }, [loadPosts]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    setPage(nextPage);
    loadPosts(nextPage);
  }, [loadingMore, hasMore, page, loadPosts]);

  const handlePostCreated = useCallback((newPost) => {
    if (newPost) {
      setPosts(prev => {
        const next = [newPost, ...prev];
        lastFeedFpRef.current = _feedFingerprint(next);
        _saveFeedToMMKV(next);
        return next;
      });
    } else {
      // Reload from server
      loadPosts(1, true);
    }
  }, [loadPosts]);

  const handleDeletePost = useCallback((postId) => {
    setPosts(prev => {
      const next = prev.filter(p => p.id !== postId);
      lastFeedFpRef.current = _feedFingerprint(next);
      _saveFeedToMMKV(next);
      return next;
    });
  }, []);

  const handleOpenComments = useCallback((post) => {
    setCommentsPost(post);
  }, []);

  const handleCommentCountChange = useCallback((newCount) => {
    if (!commentsPost) return;
    setPosts(prev => prev.map(p =>
      p.id === commentsPost.id ? { ...p, comment_count: newCount } : p
    ));
    setCommentsPost(prev => prev ? { ...prev, comment_count: newCount } : null);
  }, [commentsPost]);

  const isWeb = Platform.OS === 'web';

  const renderLiveHeader = useCallback(() => {
    if (activeLives.length === 0) return null;
    return (
      <View style={[styles.liveSection, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }]}>
        <View style={styles.liveSectionHeader}>
          <LiveIndicator size="small" />
          <Text style={[styles.liveSectionTitle, { color: colors.text }]}>
            {t('live.liveNow')}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.liveScroll}
        >
          {activeLives.map((live) => (
            <TouchableOpacity
              key={live.id || live.session_id}
              style={[styles.liveCard, {
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
                ...(isWeb ? {
                  boxShadow: isDark
                    ? '0 2px 8px rgba(0,0,0,0.3)'
                    : '0 2px 8px rgba(0,0,0,0.08)',
                } : {}),
              }]}
              onPress={() => router.push({
                pathname: '/live-viewer',
                params: {
                  sessionId: live.id || live.session_id,
                  hostEmail: live.host_email,
                  hostName: live.host_name,
                  title: live.title,
                },
              })}
              activeOpacity={0.7}
              accessibilityLabel={`${t('live.liveNow')}: ${live.host_name || live.host_email}`}
              accessibilityRole="button"
            >
              <View style={styles.liveAvatarWrap}>
                <View style={styles.liveAvatarRing}>
                  <AvatarCircle
                    name={live.host_name}
                    email={live.host_email}
                    size={50}
                  />
                </View>
                <View style={styles.liveBadgeSmall}>
                  <Text style={styles.liveBadgeText}>LIVE</Text>
                </View>
              </View>
              <Text style={[styles.liveHostName, { color: colors.text }]} numberOfLines={1}>
                {live.host_name || live.host_email?.split('@')[0] || '?'}
              </Text>
              {live.viewer_count != null && (
                <Text style={[styles.liveViewers, { color: colors.textSecondary }]}>
                  {live.viewer_count} {live.viewer_count === 1 ? t('live.viewer') : t('live.viewers')}
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  }, [activeLives, isDark, colors, t, router, isWeb]);

  const handlePressUser = useCallback((email, name) => {
    router.push({ pathname: '/user-profile', params: { email, name: name || '' } });
  }, [router]);

  // ── Search bar ──
  const renderSearchBar = () => (
    <View style={[styles.searchBarContainer, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    }]}>
      <View style={[styles.searchInputWrap, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
        flex: 1,
      }]}>
        <IconSearch size={18} color={isDark ? '#888' : '#999'} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t('feed.searchPlaceholder')}
          placeholderTextColor={isDark ? '#666' : '#999'}
          value={searchQuery}
          onChangeText={(text) => {
            setIsSearchActive(true);
            handleSearchChange(text);
          }}
          onFocus={() => setIsSearchActive(true)}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {(searchQuery.length > 0 || isSearchActive) && (
          <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconX size={18} color={isDark ? '#888' : '#999'} />
          </TouchableOpacity>
        )}
      </View>
      <TouchableOpacity
        onPress={() => { setUnreadNotifs(0); try { router?.push('/notifications-feed'); } catch {} }}
        activeOpacity={0.7}
        accessibilityLabel={t('notifications.title') || 'Notificações'}
        accessibilityRole="button"
        style={{ padding: 6, position: 'relative' }}
      >
        <IconBell size={22} color={colors.text} />
        {unreadNotifs > 0 && (
          <View style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 16, height: 16, borderRadius: 8,
            paddingHorizontal: 4,
            backgroundColor: '#ef4444',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>
              {unreadNotifs > 9 ? '9+' : String(unreadNotifs)}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );

  // ── Search results list ──
  const renderUserCard = useCallback(({ item: usr }) => (
    <TouchableOpacity
      style={[styles.userCard, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff',
        ...(isWeb ? {
          boxShadow: isDark
            ? '0 1px 4px rgba(0,0,0,0.3)'
            : '0 1px 4px rgba(0,0,0,0.06)',
        } : {}),
      }]}
      onPress={() => {
        clearSearch();
        handlePressUser(usr.email, usr.name);
      }}
      activeOpacity={0.7}
      accessibilityLabel={usr.name || usr.email}
      accessibilityRole="button"
    >
      <AvatarCircle name={usr.name} email={usr.email} size={50} />
      <View style={styles.userCardInfo}>
        <Text style={[styles.userCardName, { color: colors.text }]} numberOfLines={1}>
          {usr.name || usr.email.split('@')[0]}
        </Text>
        <Text style={[styles.userCardEmail, { color: colors.textSecondary }]} numberOfLines={1}>
          {usr.email}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.followButton}
        onPress={() => {
          clearSearch();
          handlePressUser(usr.email, usr.name);
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.followButtonText}>{t('profile.follow')}</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  ), [isDark, colors, isWeb, t, handlePressUser, clearSearch]);

  const renderSearchContent = () => {
    if (searchLoading) {
      return (
        <View style={styles.searchStatusContainer}>
          <ActivityIndicator size="small" color={ACCENT} />
        </View>
      );
    }
    if (searchQuery.trim().length >= 2 && searchResults.length === 0) {
      return (
        <View style={styles.searchStatusContainer}>
          <Text style={[styles.searchStatusText, { color: colors.textSecondary }]}>
            {t('feed.noResults')}
          </Text>
        </View>
      );
    }
    if (searchQuery.trim().length < 2 && isSearchActive) {
      return (
        <View style={styles.searchStatusContainer}>
          <IconSearch size={40} color={isDark ? '#333' : '#ddd'} />
          <Text style={[styles.searchStatusText, { color: colors.textSecondary, marginTop: 12 }]}>
            {t('feed.searchHint')}
          </Text>
        </View>
      );
    }
    return (
      <FlatList
        data={searchResults}
        renderItem={renderUserCard}
        keyExtractor={(item) => item.email}
        contentContainerStyle={styles.searchResultsList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  const renderPost = useCallback(({ item }) => (
    <FeedPostRow
      post={item}
      colors={colors}
      isDark={isDark}
      t={t}
      user={user}
      onOpenComments={handleOpenComments}
      onPostUpdated={() => {}}
      onDeletePost={handleDeletePost}
      onPressUser={handlePressUser}
    />
  ), [colors, isDark, t, user, handleOpenComments, handleDeletePost, handlePressUser]);

  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color={ACCENT} />
      </View>
    );
  }, [loadingMore]);

  const renderEmpty = useCallback(() => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <EmptyFeedIllustration isDark={isDark} />
        <Text style={[styles.emptyText, { color: colors.text }]}>
          {t('feed.empty')}
        </Text>
        <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>
          {t('feed.emptySubtext')}
        </Text>
      </View>
    );
  }, [loading, isDark, colors, t]);

  // ── Tab toggle bar ──
  const renderTabBar = () => (
    <View style={[styles.tabBar, {
      backgroundColor: isDark ? colors.background : '#f6f8fa',
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    }]}>
      <TouchableOpacity
        style={[styles.tabItem, feedMode === 'posts' && styles.tabItemActive]}
        onPress={() => setFeedMode('posts')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.posts') || 'Posts'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: feedMode === 'posts' ? ACCENT : (isDark ? '#aaa' : '#666') },
          feedMode === 'posts' && styles.tabItemTextActive,
        ]}>
          {t('feed.posts') || 'Posts'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.tabItem, feedMode === 'reels' && styles.tabItemActive]}
        onPress={() => setFeedMode('reels')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.reels') || 'Reels'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: feedMode === 'reels' ? ACCENT : (isDark ? '#aaa' : '#666') },
          feedMode === 'reels' && styles.tabItemTextActive,
        ]}>
          {t('feed.reels') || 'Reels'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.tabItem}
        onPress={() => router.push('/spotlight')}
        activeOpacity={0.7}
        accessibilityLabel={t('spotlight.title') || 'Spotlight'}
        accessibilityRole="tab"
      >
        <Text style={[styles.tabItemText, { color: isDark ? '#aaa' : '#666' }]}>
          ✨ {t('spotlight.title') || 'Spotlight'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.tabItem, feedMode === 'profile' && styles.tabItemActive]}
        onPress={() => setFeedMode('profile')}
        activeOpacity={0.7}
        accessibilityLabel={t('feed.profile') || 'Perfil'}
        accessibilityRole="tab"
      >
        <Text style={[
          styles.tabItemText,
          { color: feedMode === 'profile' ? ACCENT : (isDark ? '#aaa' : '#666') },
          feedMode === 'profile' && styles.tabItemTextActive,
        ]}>
          {t('feed.profile') || 'Perfil'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  // ── Search mode ──
  if (isSearchActive && searchQuery.length > 0) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderSearchContent()}
      </View>
    );
  }

  // ── Profile mode (Instagram-style) ──
  if (feedMode === 'profile') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderTabBar()}
        <FeedProfileSection colors={colors} isDark={isDark} t={t} user={user} router={router} onCreatePost={() => setCreateVisible(true)} />
        <CreatePostModal
          visible={createVisible}
          colors={colors}
          isDark={isDark}
          t={t}
          user={user}
          onClose={() => setCreateVisible(false)}
          onPostCreated={handlePostCreated}
        />
      </View>
    );
  }

  // ── Reels mode (full-screen immersive) ──
  if (feedMode === 'reels') {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        <ReelsViewer colors={colors} isDark={isDark} t={t} user={user} />
        {/* Small back-to-posts pill at top-left */}
        <TouchableOpacity
          style={styles.backToPostsPill}
          onPress={() => setFeedMode('posts')}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.posts') || 'Posts'}
          accessibilityRole="button"
        >
          <Text style={styles.backToPostsText}>{t('feed.posts') || 'Posts'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Posts mode (existing) ──
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        {renderSearchBar()}
        {renderTabBar()}
        <FeedSkeleton isDark={isDark} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      <ListComponent
        data={posts}
        renderItem={renderPost}
        keyExtractor={(item) => String(item.id)}
        estimatedItemSize={450}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={ACCENT}
            colors={[ACCENT]}
          />
        }
        ListHeaderComponent={() => <>{renderSearchBar()}{renderTabBar()}{renderLiveHeader()}</>}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={posts.length === 0 && activeLives.length === 0 ? { flex: 1 } : undefined}
        keyboardShouldPersistTaps="handled"
      />

      {/* Go Live FAB */}
      <TouchableOpacity
        style={[styles.fabLive, {
          ...(isWeb ? { boxShadow: '0 4px 14px rgba(220,38,38,0.4), 0 2px 6px rgba(0,0,0,0.1)' } : {}),
        }]}
        onPress={() => router.push('/live-broadcast')}
        activeOpacity={0.8}
        accessibilityLabel={t('live.goLive')}
        accessibilityRole="button"
      >
        <IconVideo size={20} color="#fff" />
      </TouchableOpacity>

      {/* FAB to create post */}
      <TouchableOpacity
        style={[styles.fab, {
          ...(isWeb ? { boxShadow: '0 4px 14px rgba(124,58,237,0.4), 0 2px 6px rgba(0,0,0,0.1)' } : {}),
        }]}
        onPress={() => setCreateVisible(true)}
        activeOpacity={0.8}
        accessibilityLabel={t('feed.createPost')}
        accessibilityRole="button"
      >
        <IconPlus size={24} color="#fff" />
      </TouchableOpacity>

      {/* Create post modal */}
      <CreatePostModal
        visible={createVisible}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCreateVisible(false)}
        onPostCreated={handlePostCreated}
      />

      {/* Comments modal */}
      <FeedComments
        visible={!!commentsPost}
        post={commentsPost}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsPost(null)}
        onCommentCountChange={handleCommentCountChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Empty state
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyText: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 20,
  },
  emptySubtext: {
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 18,
  },
  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#7C3AED',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
      },
      android: { elevation: 6 },
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.15)' },
    }),
  },
  fabLive: {
    position: 'absolute',
    bottom: 92,
    right: 21,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#dc2626',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: { elevation: 8 },
      default: {},
    }),
  },
  // Live section
  liveSection: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  liveSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 10,
  },
  liveSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  liveScroll: {
    paddingHorizontal: 12,
    gap: 10,
  },
  liveCard: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    width: 100,
  },
  liveAvatarWrap: {
    position: 'relative',
    marginBottom: 6,
  },
  liveAvatarRing: {
    borderWidth: 2.5,
    borderColor: '#dc2626',
    borderRadius: 28,
    padding: 2,
  },
  liveBadgeSmall: {
    position: 'absolute',
    bottom: -2,
    left: '50%',
    marginLeft: -16,
    backgroundColor: '#dc2626',
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  liveBadgeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  liveHostName: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  liveViewers: {
    fontSize: 10,
    marginTop: 2,
  },
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  tabItemActive: {
    borderBottomColor: '#7C3AED',
  },
  tabItemText: {
    fontSize: 14,
    fontWeight: '500',
  },
  tabItemTextActive: {
    fontWeight: '600',
  },
  // Footer
  footerLoader: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  // Search bar
  searchBarContainer: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
    ...Platform.select({
      web: { outlineStyle: 'none' },
      default: {},
    }),
  },
  // Search results
  searchResultsList: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 20,
  },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    marginBottom: 8,
    gap: 12,
  },
  userCardInfo: {
    flex: 1,
    gap: 2,
  },
  userCardName: {
    fontSize: 15,
    fontWeight: '600',
  },
  userCardEmail: {
    fontSize: 13,
  },
  followButton: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  followButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  searchStatusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  searchStatusText: {
    fontSize: 15,
  },
  // Back to posts pill (reels mode)
  backToPostsPill: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 18,
    left: 14,
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    zIndex: 30,
  },
  backToPostsText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
