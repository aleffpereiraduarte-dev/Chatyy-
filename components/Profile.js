/**
 * Profile — unified profile component (peek + full modes).
 *
 * Replaces:
 *   - ProfileViewerModal (peek overlay from chat header)
 *   - /user-profile screen (full-screen profile)
 *
 * Modes:
 *   - "peek": overlay/bottom-sheet. Avatar, name, presence, 4 actions,
 *            bio, 6 top posts, 6 shared-media thumbs, common chats list,
 *            "See full profile" button.
 *   - "full": route /u/[username]. Same header, then tabs:
 *            Posts | Reels | Mídia | Chat | Email.
 *
 * Data comes from ONE fetch: api.profileGet(email). No N+1.
 *
 * Entry points wire with:
 *   router.push(`/u/${encodeURIComponent(email)}`)       // full
 *   setPeekProfile({ email })                            // peek
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Image,
  Platform, Modal, Pressable, ActivityIndicator, Dimensions, Animated, Alert, TextInput,
  PanResponder, Easing,
} from 'react-native';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from './AvatarCircle';
import StoryRingAvatar from './status/StoryRingAvatar';
import StoryViewer from './status/StoryViewer';
import ProfilePostViewer from './ProfilePostViewer';
import ProfileEditSheet from './ProfileEditSheet';
import ProfileSettingsSheet from './ProfileSettingsSheet';
import FollowersSheet from './FollowersSheet';
import EmptyStateCard from './EmptyStateCard';
import {
  IconX, IconPhone, IconVideo, IconMail, IconMessageSquare, IconUserPlus,
  IconChevronRight, IconSettings, IconMoreHorizontal, IconShare, IconAlertTriangle, IconLock, IconEdit,
  IconTrash, IconPlus, IconGrid, IconFilm, IconTag, IconCheck,
} from './Icons';
const IconEdit3 = IconEdit;
const IconTrash2 = IconTrash;

const WEB = Platform.OS === 'web';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Module-level stale-while-revalidate cache for profile_get. Keyed by the
// email-or-username argument. When a profile is re-opened within TTL we paint
// instantly from cache and revalidate in the background, which is what
// Instagram/WhatsApp feel like. Posts/reels/media thumbnails themselves are
// cached by expo-image's disk layer (see GridItem below).
const _profileCache = new Map(); // key -> { data, ts }
const PROFILE_TTL_MS = 2 * 60 * 1000; // 2 min — fresh enough for presence

export function invalidateProfileCache(key) {
  if (key == null) _profileCache.clear();
  else _profileCache.delete(String(key).toLowerCase());
}

function _cacheGet(key) {
  if (!key) return null;
  const hit = _profileCache.get(String(key).toLowerCase());
  if (!hit) return null;
  return hit;
}

function _cacheSet(key, data) {
  if (!key) return;
  _profileCache.set(String(key).toLowerCase(), { data, ts: Date.now() });
}

// Lazy expo-image for disk-cached grid/story thumbnails (avoids blank flicker
// when re-opening a profile). Falls back to react-native Image if unavailable.
let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}

// ─── Small helpers ────────────────────────────────────────────────────
function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace('.0', '') + 'k';
  return String(n);
}

function resolveMedia(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url}`;
}

// Row style for the three-dot action sheet (Share/Block/Report).
function menuItemStyle(colors) {
  return {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingVertical: 14,
  };
}

// Relative time for "visto há 2h" / "online agora"
function relativeLastSeen(ts, t) {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - Number(ts);
  if (diff < 60)       return t?.('time.justNow') || 'agora';
  if (diff < 3600)     return `${Math.floor(diff / 60)} min`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)} h`;
  return `${Math.floor(diff / 86400)} d`;
}

// ─── Action button (phone/video/mail/msg/follow) ─────────────────────
// Instagram-style flat button: 50% width, rounded corners, bold label. Primary
// variant is solid purple (for "Follow"), secondary is filled surface color.
function FlatButton({ label, onPress, isPrimary, colors, isDark }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        paddingVertical: 9,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: isPrimary ? '#7C3AED' : (colors?.surface || (isDark ? '#222' : '#efefef')),
        borderWidth: isPrimary ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors?.border || 'transparent',
      }}
    >
      <Text style={{
        fontSize: 14,
        fontWeight: '600',
        color: isPrimary ? '#fff' : colors?.text,
      }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// Secondary chip with icon + label — used for supplementary actions (call,
// video, email) that sit below the primary Follow/Message row.
function ChipButton({ icon: Icon, label, onPress, colors, isDark }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 8,
        borderRadius: 9,
        backgroundColor: colors?.surface || (isDark ? '#1f1f1f' : '#f4f4f4'),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors?.border || 'transparent',
      }}
    >
      {Icon && <Icon size={15} color={colors?.text} />}
      <Text style={{ fontSize: 13, fontWeight: '500', color: colors?.text }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ActionButton({ icon: Icon, label, onPress, colors, isPrimary }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={{ alignItems: 'center', flex: 1, gap: 6 }}
    >
      <View style={{
        width: 44, height: 44, borderRadius: 22,
        backgroundColor: isPrimary ? '#7C3AED' : (colors?.surface || '#f4f4f4'),
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={20} color={isPrimary ? '#fff' : (colors?.text || '#111')} />
      </View>
      <Text style={{ fontSize: 11, color: colors?.text || '#111', fontWeight: '500' }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Stat column ──────────────────────────────────────────────────────
function Stat({ value, label, onPress, colors }) {
  // Slightly chunkier number with a tabular-nums variant so 1K vs 999
  // don't shift width when count tips over. Label uppercased + tighter
  // letter-spacing for a more "stats card" feel (Instagram parity).
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={!onPress}
      style={{ flex: 1, alignItems: 'center', paddingVertical: 2 }}
    >
      <Text style={{
        fontSize: 22, fontWeight: '800', color: colors?.text, letterSpacing: -0.5,
        fontVariant: ['tabular-nums'],
      }}>
        {formatCount(value)}
      </Text>
      <Text style={{
        fontSize: 12, color: colors?.textSecondary, marginTop: 4,
        letterSpacing: 0.1, fontWeight: '500',
      }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Profile skeleton ────────────────────────────────────────────────
// Instagram-style placeholder enquanto profile_get carrega. Substitui o
// spinner solitario que dava sensacao de "tela vazia". Pinta a estrutura
// real (avatar circular + 3 stats + 6 grid tiles) com pulse subtil.
function ProfileSkeleton({ colors, isDark }) {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const tone = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const Bar = ({ w, h, mt = 0, br = 6 }) => (
    <Animated.View style={{ width: w, height: h, borderRadius: br, backgroundColor: tone, marginTop: mt, opacity: pulse }} />
  );
  // Posts-grid placeholder uses 33% width tiles (3-col Instagram grid)
  const screenW = Dimensions.get('window').width;
  const tile = Math.floor((screenW - 4) / 3) - 1;
  return (
    <View style={{ paddingTop: 14 }}>
      {/* Header row: avatar + 3 stats */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 20 }}>
        <Animated.View style={{ width: 86, height: 86, borderRadius: 43, backgroundColor: tone, opacity: pulse }} />
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around' }}>
          {[0, 1, 2].map(i => (
            <View key={i} style={{ alignItems: 'center', gap: 6 }}>
              <Bar w={32} h={20} br={5} />
              <Bar w={50} h={11} />
            </View>
          ))}
        </View>
      </View>
      {/* Name + bio */}
      <View style={{ paddingHorizontal: 16, marginTop: 14, gap: 6 }}>
        <Bar w={140} h={14} />
        <Bar w={'70%'} h={11} mt={4} />
        <Bar w={'45%'} h={11} mt={2} />
      </View>
      {/* Action buttons */}
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginTop: 14 }}>
        <Bar w={'48%'} h={36} br={10} />
        <Bar w={'48%'} h={36} br={10} />
      </View>
      {/* Tab strip */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 22, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tone }}>
        {[0, 1, 2].map(i => <Bar key={i} w={28} h={20} />)}
      </View>
      {/* Posts grid */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, padding: 1, marginTop: 1 }}>
        {[0, 1, 2, 3, 4, 5].map(i => (
          <Animated.View key={i} style={{ width: tile, height: tile, backgroundColor: tone, opacity: pulse }} />
        ))}
      </View>
    </View>
  );
}

// ─── Grid item (post thumb) ──────────────────────────────────────────
// Uses expo-image on native for disk-cached thumbs so scrolling back into a
// profile doesn't re-download every tile. Web falls back to native <img>
// (browser cache handles persistence).
function GridItem({ item, size, onPress, isReel }) {
  const rawThumb = item.thumbnail || item.url || '';
  const url = resolveMedia(rawThumb);
  const looksLikeVideo = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(url)
    || item.type === 'video' || item.media_type === 'video' || isReel;
  // Poster URL pra grid de vídeos. Three-tier fallback porque legacy posts
  // têm padrões diferentes:
  //  1. Se thumbnail_url já É um JPG/PNG/WEBP, usa direto (caso `..._thumb.jpg`)
  //  2. Se não, tenta convenção `<file>.thumb.jpg` (caso ffmpeg sibling)
  //  3. Falha → posterFailed → mostra dark placeholder com play icon
  // (User reportou: thumbnails do @ces-junior pretos. id 11 tinha `_thumb.jpg`
  // (sem ponto) que estava em R2, mas o guess `.thumb.jpg` apontava p/ URL 404.)
  const thumbIsImage = /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(rawThumb);
  const guessedPosterUrl = looksLikeVideo && url
    ? (thumbIsImage ? resolveMedia(rawThumb) : resolveMedia(rawThumb + '.thumb.jpg'))
    : null;
  const [posterFailed, setPosterFailed] = React.useState(false);
  const renderImg = () => {
    if (!url) return <View style={{ width: '100%', height: '100%', backgroundColor: '#222', borderRadius: 3 }} />;
    if (WEB) {
      if (looksLikeVideo) {
        return (
          <video
            src={url + '#t=0.1'}
            preload="metadata"
            muted
            playsInline
            poster={guessedPosterUrl || undefined}
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3, background: '#111' }}
          />
        );
      }
      return <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3 }} alt="" loading="lazy" decoding="async" />;
    }
    if (looksLikeVideo) {
      // Try the ffmpeg-generated sibling poster (`<video>.thumb.jpg`). If
      // that 404s (legacy reel uploaded before the backfill ran), fall
      // back to a dark placeholder — the video badge is rendered above it.
      if (guessedPosterUrl && !posterFailed && _ExpoImage) {
        return (
          <_ExpoImage
            source={{ uri: guessedPosterUrl }}
            style={{ width: '100%', height: '100%', borderRadius: 3 }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            onError={() => setPosterFailed(true)}
          />
        );
      }
      return <View style={{ width: '100%', height: '100%', backgroundColor: '#1a1a1a', borderRadius: 3 }} />;
    }
    if (_ExpoImage) {
      return (
        <_ExpoImage
          source={{ uri: url }}
          style={{ width: '100%', height: '100%', borderRadius: 3 }}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
        />
      );
    }
    return <Image source={{ uri: url }} style={{ width: '100%', height: '100%', borderRadius: 3 }} resizeMode="cover" />;
  };
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{ width: size, height: size, padding: 1 }}
    >
      {renderImg()}
      {(item.type === 'video' || isReel) && (
        <View style={{ position: 'absolute', top: 6, right: 6 }}>
          <IconVideo size={14} color="#fff" />
        </View>
      )}
    </TouchableOpacity>
  );
}


// ─── Main Profile component ──────────────────────────────────────────
export default function Profile({
  mode = 'peek',           // "peek" | "full"
  email,                   // required if no username
  username,                // alternative to email
  visible = true,          // peek mode: modal visibility
  onClose,                 // peek mode: close callback
  onOpenChat,              // callback: (email) => navigate to chat-conversation
  onOpenCall,              // callback: (email, video?) => start call
  onOpenEmail,             // callback: (email) => open compose
  onOpenFollowers,         // callback: (email) => followers list
  onOpenFullProfile,       // callback from peek → open /u/username
  onOpenSettings,          // self-only: gear icon → settings sheet (optional override)
  onLogout,                // self-only: signs current session out
  headerLeadingSpace = 0,  // px reserved on the left of row 1 so an absolute-positioned back button doesn't cover @username
  autoOpenStory = false,   // when true and stories exist, auto-open the story viewer (chat status_reply tap path)
  autoOpenSettings = false, // when true and is_self, auto-open the settings bottom sheet (Apps drawer "Configurações" entry)
  colors, isDark, t, router,
}) {
  // Current session's user — needed so the embedded FeedComments sheet
  // knows whose avatar to stamp on new comments. Kept internal so callers
  // don't have to pass user through every layer.
  const { user: currentUser, logout: authLogout } = useAuth() || {};
  const fetchKey = email || username;

  // Seed state from cache so the first paint is instant when re-opening a
  // profile within TTL. Network revalidation still runs below.
  const [data, setData] = useState(() => _cacheGet(fetchKey)?.data || null);
  const [loading, setLoading] = useState(() => !_cacheGet(fetchKey));
  const [err, setErr] = useState(null);
  // 401 surfaces as an "expired session" state with a Sign-out CTA instead of
  // bare "Not authenticated" text — that string was leaking on the profile
  // route when bearer/cookie went stale (incidente 2026-05-04 prints).
  const [errStatus, setErrStatus] = useState(0);
  const [retryCounter, setRetryCounter] = useState(0);
  const [activeTab, setActiveTab] = useState('posts');
  const [viewer, setViewer] = useState({ open: false, startIdx: 0, list: 'posts' });
  const [storyViewer, setStoryViewer] = useState({ open: false, startIdx: 0 });
  // autoOpenStory path: chat status_reply tap routes here with the intent to
  // pop the story viewer open if the original status is still live (within
  // 24h). Fire once when stories load. Ref guard so swiping back/forward
  // through the same profile doesn't re-trigger the modal.
  const _autoStoryFiredRef = useRef(false);
  useEffect(() => {
    if (!autoOpenStory) return;
    if (_autoStoryFiredRef.current) return;
    const stories = data?.stories;
    if (!stories || stories.length === 0) return;
    _autoStoryFiredRef.current = true;
    setStoryViewer({ open: true, startIdx: 0 });
  }, [autoOpenStory, data?.stories]);
  const [editOpen, setEditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Auto-open settings sheet when arriving via deeplink (?openSettings=1).
  // Apps drawer "Configurações" tile uses this path so it converges on the
  // same single-source-of-truth sheet that the gear icon opens — instead of
  // pushing /settings (legacy email-focused screen). Fired once on data load.
  const _autoSettingsFiredRef = useRef(false);
  useEffect(() => {
    if (!autoOpenSettings) return;
    if (_autoSettingsFiredRef.current) return;
    if (!data?.is_self) return;
    _autoSettingsFiredRef.current = true;
    setSettingsOpen(true);
  }, [autoOpenSettings, data?.is_self]);
  const [followersTab, setFollowersTab] = useState(null); // null | 'followers' | 'following'
  // Per-user contact nickname (WhatsApp-style rename). Loaded from the
  // chat_nickname_list endpoint on mount; overrides display name locally.
  const [nicknameValue, setNicknameValue] = useState('');

  useEffect(() => {
    if (!fetchKey) return;
    if (mode === 'peek' && !visible) return;

    // Hydrate from cache synchronously — paint instantly, revalidate silently.
    const cached = _cacheGet(fetchKey);
    if (cached) {
      setData(cached.data);
      setLoading(false);
      // Fresh within TTL? Skip the network revalidation entirely.
      if (Date.now() - cached.ts < PROFILE_TTL_MS) return;
    } else {
      setData(null);
      setLoading(true);
    }
    setErr(null);
    setErrStatus(0);

    let cancelled = false;
    (async () => {
      try {
        const r = await api.profileGet(fetchKey);
        if (cancelled) return;
        if (r?.success && r.data) {
          _cacheSet(fetchKey, r.data);
          setData(r.data);
          // Sync the server's avatar_version into the global cache-bust map
          // so any AvatarCircle elsewhere that builds the URL via
          // getAvatarUrlForEmail() picks up the new photo immediately,
          // not just the spots that read identity.avatar_url directly.
          try {
            const ident = r.data?.identity;
            if (ident?.email && typeof ident.avatar_version === 'number' && ident.avatar_version > 0) {
              api.bustAvatarCache(ident.email, ident.avatar_version);
            }
          } catch {}
        } else if (!cached) {
          // apiCall returns the JSON body (no HTTP status). Detect auth
          // failure by canonical backend message instead — "Not authenticated"
          // is what requireAuth() emits on 401.
          const msg = r?.message || 'Failed to load profile';
          setErr(msg);
          setErrStatus(/not authenticated/i.test(msg) ? 401 : 0);
        }
      } catch (e) {
        if (!cancelled && !cached) {
          const msg = e?.message || 'Failed to load profile';
          setErr(msg);
          setErrStatus(/not authenticated/i.test(msg) ? 401 : 0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchKey, visible, mode, retryCounter]);

  const identity = data?.identity;

  // Load saved nickname when we know which identity we're viewing.
  useEffect(() => {
    if (!identity?.email) return;
    (async () => {
      try {
        const r = await api.chatNicknameList();
        const n = r?.data?.nicknames?.[identity.email.toLowerCase()] || '';
        setNicknameValue(n);
      } catch {}
    })();
  }, [identity?.email]);
  const presence = data?.presence;
  const social = data?.social;
  const actions = data?.actions || {};
  const selfOnly = data?.self_only;
  const posts = data?.posts || [];
  const reels = data?.reels || [];
  const sharedMedia = data?.shared_media || [];
  const commonChats = data?.common_chats || [];
  const emailPreview = data?.email_preview || [];
  const stories = data?.stories || [];

  // Presence text
  const presenceText = useMemo(() => {
    if (!presence) return '';
    if (presence.online) return t?.('profile.online') || 'online';
    if (presence.last_seen) {
      return `${t?.('profile.lastSeen') || 'Visto'} ${relativeLastSeen(presence.last_seen, t)} ${t?.('profile.ago') || 'atrás'}`;
    }
    return '';
  }, [presence, t]);

  // Grid sizes
  const gridSize = useMemo(() => {
    const w = mode === 'peek' ? Math.min(SCREEN_W, 380) : Math.min(SCREEN_W, 640);
    return Math.floor(w / 3);
  }, [mode]);

  // Handlers
  const handleChat = useCallback(() => { onOpenChat?.(identity?.email); onClose?.(); }, [identity, onOpenChat, onClose]);
  const handleCall = useCallback(() => { onOpenCall?.(identity?.email, false); }, [identity, onOpenCall]);
  const handleVideo = useCallback(() => { onOpenCall?.(identity?.email, true); }, [identity, onOpenCall]);
  const handleEmail = useCallback(() => { onOpenEmail?.(identity?.email); onClose?.(); }, [identity, onOpenEmail, onClose]);
  // Single-flight lock so rapid taps on Follow/Unfollow don't race — without
  // this, double-tap fired overlapping requests and left the counter stuck on
  // whichever response landed last. Matches the FollowersSheet pattern.
  const followInFlightRef = useRef(false);
  const handleFollow = useCallback(async () => {
    if (!identity?.email) return;
    if (followInFlightRef.current) return;
    followInFlightRef.current = true;
    // Optimistic UI update so the tap feels instant.
    setData(prev => prev ? { ...prev, social: { ...prev.social, is_following: !prev.social.is_following, followers_count: prev.social.followers_count + (prev.social.is_following ? -1 : 1) } } : prev);
    try {
      if (social?.is_following) await api.unfollowUser?.(identity.email);
      else                       await api.followUser?.(identity.email);
    } catch {
      // Revert on failure.
      setData(prev => prev ? { ...prev, social: { ...prev.social, is_following: !prev.social.is_following, followers_count: prev.social.followers_count + (prev.social.is_following ? -1 : 1) } } : prev);
    } finally {
      followInFlightRef.current = false;
    }
  }, [identity, social]);

  const handleOpenFullFromPeek = useCallback(() => {
    const un = identity?.username || identity?.email;
    if (un && router) router.push(`/u/${encodeURIComponent(un)}`);
    onOpenFullProfile?.(identity?.email);
    onClose?.();
  }, [identity, router, onOpenFullProfile, onClose]);

  // Open the inline post viewer when user taps a grid thumbnail. Keeps them
  // inside the profile flow (swipeable carousel of that user's posts),
  // instead of navigating away and losing scroll position. Shared chat
  // media doesn't live in chat_feed_posts so fall back to the conversation.
  const handleOpenPost = useCallback((item, listName = 'posts') => {
    if (!item) return;
    // Shared chat media — open inside the conversation
    if (!item.id && item.conversation_id && router) {
      if (mode === 'peek') onClose?.();
      router.push(`/chat-conversation?id=${item.conversation_id}`);
      return;
    }
    if (!item.id) return;
    // Comparação por string pra evitar mismatch entre number id (do JSON
    // do servidor) e string id (de cache local). Antes `p.id === item.id`
    // dava false em "123" vs 123 e a viewer não abria.
    const targetId = String(item.id);
    let list = listName === 'reels' ? reels : (listName === 'media' ? sharedMedia : posts);
    let resolvedListName = listName;
    let idx = list.findIndex(p => String(p.id) === targetId);
    if (idx < 0) {
      // Fallback: tenta os outros buckets antes de desistir (Foto 1: clicar
      // num reel da tab Posts combinada — o reel pode estar só em `posts`).
      const tryLists = [
        ['posts', posts],
        ['reels', reels],
        ['media', sharedMedia],
      ];
      for (const [name, arr] of tryLists) {
        const j = arr.findIndex(p => String(p.id) === targetId);
        if (j >= 0) { resolvedListName = name; list = arr; idx = j; break; }
      }
    }
    if (idx < 0) {
      // Último recurso: abre o viewer com SÓ o item clicado, mesmo que ele
      // não exista nos arrays (post veio de outro endpoint, etc.). Antes
      // o tap virava no-op silencioso — pior UX. Vamos passar pelo viewer
      // com um array de 1 item.
      setViewer({ open: true, startIdx: 0, list: 'single', singleItem: item });
      return;
    }
    setViewer({ open: true, startIdx: idx, list: resolvedListName });
  }, [router, mode, onClose, posts, reels, sharedMedia]);

  // ─── Stories row (Instagram highlights style) ────────────────────────
  // Shows active 24h stories as circular thumbs with a gradient ring so they
  // read as "story available" vs "already viewed" (Instagram/WhatsApp convention).
  // Tap → opens /status-viewer?email=X (existing route) or falls back to the
  // chat Status tab if the viewer screen isn't registered.
  const renderStoriesRow = () => {
    if (!stories || stories.length === 0) return null;
    // Tap opens the inline viewer (Modal below). Previously this routed to
    // /chat?tab=status&viewStory=..., but chat.js never consumed the
    // viewStory param — so the user saw the status list, not the story,
    // which read as a "white screen".
    const openStory = (startIdx) => {
      setStoryViewer({ open: true, startIdx });
    };
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 6, gap: 12 }}
      >
        {stories.map((s, i) => {
          // Legacy fallback: some rows stored the image URL in `content`
          // when media_url was empty. DB migrated, but guard here so
          // cached responses still render the thumb.
          const rawThumb = s.media_url
            || ((s.type === 'image' || s.type === 'video')
                && /^(\/|https?:\/\/)/.test(String(s.content || ''))
                ? s.content : '');
          const thumbUrl = rawThumb ? resolveMedia(rawThumb) : null;
          return (
            <TouchableOpacity key={s.id} onPress={() => openStory(i)} activeOpacity={0.8}
              style={{ alignItems: 'center', width: 72 }}
            >
              {/* Gradient-style ring (two concentric views to avoid adding a lib) */}
              <View style={{
                width: 68, height: 68, borderRadius: 34, padding: 2,
                backgroundColor: '#7C3AED',
              }}>
                <View style={{
                  width: '100%', height: '100%', borderRadius: 32, padding: 2,
                  backgroundColor: colors?.background || '#fff',
                }}>
                  {thumbUrl ? (
                    WEB
                      ? <img src={thumbUrl} style={{ width: '100%', height: '100%', borderRadius: 30, objectFit: 'cover' }} alt="" />
                      : (_ExpoImage
                          ? <_ExpoImage source={{ uri: thumbUrl }} style={{ width: '100%', height: '100%', borderRadius: 30 }} contentFit="cover" cachePolicy="memory-disk" />
                          : <Image source={{ uri: thumbUrl }} style={{ width: '100%', height: '100%', borderRadius: 30 }} resizeMode="cover" />)
                  ) : (
                    <View style={{
                      flex: 1, borderRadius: 30, backgroundColor: s.bg_color || '#25D366',
                      alignItems: 'center', justifyContent: 'center', padding: 4,
                    }}>
                      <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', textAlign: 'center' }} numberOfLines={3}>
                        {(s.content || '').slice(0, 30)}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
              <Text style={{ fontSize: 11, color: colors?.text, marginTop: 4 }} numberOfLines={1}>
                {i === 0 ? (t?.('profile.story') || 'Status') : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    );
  };

  // ─── Header (identity + actions) — Instagram-style layout ───────────
  // Row 1: username + top-right menu/gear (hierarchy: top bar should read
  //        like Instagram's — @handle on left, kebab/gear on right)
  // Row 2: avatar (86px) on left + three stats (posts/followers/following)
  //        horizontally to the right of the avatar
  // Row 3: display name (bold) + bio + website link — all left-aligned,
  //        full width
  // Row 4: primary action buttons (Edit profile / Share / Follow / Message)
  //        flat, 50/50 width, NO icons. Follow is solid purple when you're
  //        not following, outline when you are — same as Instagram.

  // Handlers for the three-dot menu (non-self) AND the self "Compartilhar
  // perfil" button. These MUST be declared before renderHeader because
  // renderHeader closes over handleShareProfile — `const body = ...` calls
  // renderHeader during render, so TDZ fires if the handlers live later in
  // the function body.
  const handleShareProfile = useCallback(() => {
    const url = `https://chatyy.com.br/u/${encodeURIComponent(identity?.email || '')}`;
    setMenuOpen(false);
    try {
      if (WEB && typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: identity?.name || '', url });
      } else if (WEB && typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(url);
      } else {
        const { Share } = require('react-native');
        Share?.share({ message: url, url });
      }
    } catch {}
  }, [identity]);

  const handleBlock = useCallback(async () => {
    if (!identity?.email) return;
    setMenuOpen(false);
    try {
      await api.apiCall?.('chat_block_user', { email: identity.email }, 'POST');
      setData(prev => prev ? { ...prev, actions: { ...prev.actions, can_message: false, can_call: false, can_email: false } } : prev);
    } catch {}
  }, [identity]);

  const handleReport = useCallback(async () => {
    if (!identity?.email) return;
    setMenuOpen(false);
    try {
      await api.apiCall?.('chat_report_user', { email: identity.email, reason: 'profile_report' }, 'POST');
    } catch {}
  }, [identity]);

  const renderHeader = () => {
    if (!identity) return null;
    const postsTotal = (posts.length || 0) + (reels.length || 0);
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, gap: 14 }}>
        {/* Row 1 — @username + settings/menu (right aligned).
            headerLeadingSpace reserves room for the back arrow overlay in `full` mode so the
            @username doesn't get clipped behind it. Only row 1 gets the offset — posts/reels
            grid stays edge-to-edge so cells don't overflow off-screen on mobile widths. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: headerLeadingSpace }}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: colors?.text }} numberOfLines={1}>
              {identity.username ? `@${identity.username}` : identity.name}
            </Text>
            {identity.verified && (
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#1DA1F2', alignItems: 'center', justifyContent: 'center' }}>
                <IconCheck size={11} color="#fff" strokeWidth={3} />
              </View>
            )}
          </View>
          {actions.is_self && (
            <TouchableOpacity onPress={() => (onOpenSettings ? onOpenSettings() : setSettingsOpen(true))} style={{ padding: 6 }} accessibilityLabel={t?.('settings.title') || 'Configurações'}>
              <IconSettings size={24} color={colors?.text} />
            </TouchableOpacity>
          )}
          {!actions.is_self && (
            <TouchableOpacity onPress={() => setMenuOpen(true)} style={{ padding: 6 }} accessibilityLabel="More">
              <IconMoreHorizontal size={24} color={colors?.text} />
            </TouchableOpacity>
          )}
        </View>

        {/* Row 2 — avatar + stats laid out horizontally.
            Avatar tem ring colorido quando há status ativo (Instagram-style) e
            tap no avatar abre o viewer. Substitui a "circle Status" extra
            que ficava embaixo (visualmente redundante e abria o picker 2x). */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
          {(() => {
            const hasStories = (stories?.length || 0) > 0;
            // Wrapped in a fixed footprint so the layout stays stable when
            // hasStories toggles. The shared StoryRingAvatar sizes itself
            // exactly to its `size` (no ring) or size+padding (with ring).
            const inner = (
              <StoryRingAvatar
                name={identity.name}
                email={identity.email}
                size={86}
                ringStyle={hasStories ? 'solid' : 'none'}
                isDark={isDark}
                colors={colors}
              />
            );
            // No stories → tapping the avatar should still feel responsive:
            //   - Self viewing own profile → open picker to publish a new story
            //     (Instagram pattern: tap avatar with "+" badge)
            //   - Viewing someone else → no-op (preserves WhatsApp behaviour)
            if (!hasStories) {
              if (actions?.is_self) {
                return (
                  <TouchableOpacity
                    onPress={() => {
                      try {
                        if (Platform.OS === 'web') {
                          const input = typeof document !== 'undefined' ? document.createElement('input') : null;
                          if (!input) return;
                          input.type = 'file';
                          input.accept = 'image/*,video/*';
                          input.onchange = async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            try {
                              const uploadR = await api.statusUpload?.({ blob: f, name: f.name, type: f.type });
                              if (uploadR?.success && uploadR.data?.url) {
                                const statusType = (f.type || '').startsWith('video') ? 'video' : 'image';
                                await api.statusPublish?.(uploadR.data.url, statusType, '#000000', null, {});
                              }
                            } catch (err) { console.warn('[avatar.tap.publish.web]', err?.message); }
                          };
                          input.click();
                        } else {
                          (async () => {
                            try {
                              const ImagePicker = require('expo-image-picker');
                              const perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
                              if (!perm?.granted) return;
                              const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 });
                              if (result?.canceled || !result?.assets?.[0]) return;
                              const a = result.assets[0];
                              const file = { uri: a.uri, name: a.fileName || (a.type === 'video' ? 'status.mp4' : 'status.jpg'), type: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg') };
                              const uploadR = await api.statusUpload?.(file);
                              if (uploadR?.success && uploadR.data?.url) {
                                const statusType = a.type === 'video' ? 'video' : 'image';
                                await api.statusPublish?.(uploadR.data.url, statusType, '#000000', null, {});
                              }
                            } catch (err) { console.warn('[avatar.tap.publish.native]', err?.message); }
                          })();
                        }
                      } catch (err) { console.warn('[avatar.tap]', err?.message); }
                    }}
                    activeOpacity={0.85}
                    accessibilityLabel={t?.('profile.addStory') || 'Adicionar status'}
                  >{inner}</TouchableOpacity>
                );
              }
              return inner;
            }
            return (
              <TouchableOpacity
                onPress={() => setStoryViewer({ open: true, startIdx: 0 })}
                activeOpacity={0.85}
                accessibilityLabel={t?.('profile.viewStories') || 'Ver status'}
              >{inner}</TouchableOpacity>
            );
          })()}
          <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around' }}>
            <Stat value={postsTotal} label={t?.('profile.posts') || 'Posts'} colors={colors} />
            <Stat value={social?.followers_count || 0} label={t?.('profile.followers') || 'Seguidores'} colors={colors}
              onPress={() => (onOpenFollowers ? onOpenFollowers(identity.email, 'followers') : setFollowersTab('followers'))} />
            <Stat value={social?.following_count || 0} label={t?.('profile.following') || 'Seguindo'} colors={colors}
              onPress={() => (onOpenFollowers ? onOpenFollowers(identity.email, 'following') : setFollowersTab('following'))} />
          </View>
        </View>

        {/* Row 3 — name + bio + link + presence */}
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors?.text }} numberOfLines={1}>
            {identity.name}
          </Text>
          {!!presenceText && (
            <Text style={{ fontSize: 12, color: presence?.online ? '#22c55e' : colors?.textTertiary }}>
              {presenceText}
            </Text>
          )}
          {!!identity.bio && (
            <Text style={{ fontSize: 14, color: colors?.text, lineHeight: 19, marginTop: 2 }}>
              {identity.bio}
            </Text>
          )}
          {!!identity.website && (
            <Text style={{ fontSize: 13, color: '#7C3AED', fontWeight: '500', marginTop: 2 }} numberOfLines={1}>
              {identity.website}
            </Text>
          )}
        </View>

        {/* Row 4 — flat full-width action buttons */}
        {!actions.is_self && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {actions.can_follow && (
              <FlatButton
                label={social?.is_following ? (t?.('profile.following') || 'Seguindo') : (t?.('profile.follow') || 'Seguir')}
                onPress={handleFollow}
                isPrimary={!social?.is_following}
                colors={colors}
                isDark={isDark}
              />
            )}
            {actions.can_message && (
              <FlatButton
                label={t?.('profile.message') || 'Mensagem'}
                onPress={handleChat}
                colors={colors}
                isDark={isDark}
              />
            )}
            {!actions.can_message && actions.can_email && (
              <FlatButton
                label={t?.('profile.email') || 'Email'}
                onPress={handleEmail}
                colors={colors}
                isDark={isDark}
              />
            )}
          </View>
        )}
        {/* Secondary row for call + email when you have a message row too —
            Instagram collapses these under a "…" but we keep them as a
            smaller chip row so call is 1-tap away. */}
        {!actions.is_self && (actions.can_call || (actions.can_email && actions.can_message)) && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {actions.can_call && (
              <ChipButton icon={IconPhone} label={t?.('profile.call') || 'Ligar'} onPress={handleCall} colors={colors} isDark={isDark} />
            )}
            {actions.can_call && (
              <ChipButton icon={IconVideo} label={t?.('profile.video') || 'Vídeo'} onPress={handleVideo} colors={colors} isDark={isDark} />
            )}
            {actions.can_email && actions.can_message && (
              <ChipButton icon={IconMail} label={t?.('profile.email') || 'Email'} onPress={handleEmail} colors={colors} isDark={isDark} />
            )}
          </View>
        )}
        {actions.is_self && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <FlatButton
              label={t?.('profile.edit') || 'Editar perfil'}
              onPress={() => setEditOpen(true)}
              colors={colors}
              isDark={isDark}
            />
            <FlatButton
              label={t?.('profile.share') || 'Compartilhar perfil'}
              onPress={handleShareProfile}
              colors={colors}
              isDark={isDark}
            />
          </View>
        )}
      </View>
    );
  };

  // ─── Peek body (simpler, non-tab) ────────────────────────────────────
  const renderPeekBody = () => {
    return (
      <View style={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        {/* Top posts grid — 6 */}
        {posts.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('profile.posts') || 'Posts'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {posts.slice(0, 6).map(p => (
                <GridItem key={p.id} item={p} size={gridSize}
                  onPress={() => handleOpenPost(p)} />
              ))}
            </View>
          </>
        )}

        {/* Shared media */}
        {sharedMedia.length > 0 && (
          <>
            <View style={{ paddingHorizontal: 8, paddingTop: 12, paddingBottom: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('profile.sharedMedia') || 'Mídia compartilhada'}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8, gap: 6 }}>
              {sharedMedia.slice(0, 8).map(m => (
                <GridItem key={m.id} item={m} size={88} onPress={() => handleOpenPost(m, 'media')} />
              ))}
            </ScrollView>
          </>
        )}

        {/* Common chats */}
        {commonChats.length > 0 && (
          <>
            <View style={{ paddingHorizontal: 8, paddingTop: 14, paddingBottom: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('profile.commonChats') || 'Grupos em comum'}
              </Text>
            </View>
            {commonChats.slice(0, 5).map(c => (
              <TouchableOpacity key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 }} activeOpacity={0.7}
                onPress={() => { router?.push(`/chat-conversation?id=${c.id}`); onClose?.(); }}>
                <AvatarCircle name={c.name} size={36} />
                <Text style={{ flex: 1, fontSize: 14, color: colors?.text, fontWeight: '500' }} numberOfLines={1}>{c.name}</Text>
                <IconChevronRight size={18} color={colors?.textTertiary} />
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* See full profile */}
        <TouchableOpacity
          onPress={handleOpenFullFromPeek}
          activeOpacity={0.7}
          style={{ marginTop: 14, marginHorizontal: 12, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors?.border, alignItems: 'center' }}
        >
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors?.text }}>
            {t?.('profile.viewFull') || 'Ver perfil completo'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  // ─── Full body (with tabs) ───────────────────────────────────────────
  const renderFullBody = () => {
    // Instagram parity: posts/reels/tagged are icons-only at the top
    // (IconGrid, IconFilm, IconTag). The non-self ones (Mídia/Chat/Email)
    // keep labels because they're contextual sections without a
    // universally-recognized icon — they fall back to text + count.
    const tabs = [
      { k: 'posts', label: t?.('profile.posts') || 'Posts', count: posts.length, icon: IconGrid },
      { k: 'reels', label: t?.('profile.reels') || 'Reels', count: reels.length, icon: IconFilm },
      !actions.is_self && { k: 'media', label: t?.('profile.media') || 'Mídia', count: sharedMedia.length, icon: IconTag },
      !actions.is_self && { k: 'chat',  label: t?.('profile.chat') || 'Conversas', count: commonChats.length },
      !actions.is_self && emailPreview.length > 0 && { k: 'email', label: t?.('profile.email') || 'Email', count: emailPreview.length },
    ].filter(Boolean);

    // t() returns the literal key when the key isn't in the bundle, so the
    // simple `|| 'fallback'` short-circuit fails (the literal is truthy).
    // Use _ti to detect missing translation and fall through.
    const _ti = (key, fallback) => {
      const v = t?.(key);
      return v && v !== key ? v : fallback;
    };
    const renderTabContent = () => {
      if (activeTab === 'posts') {
        // User reportou: stat "Posts" mostra 2 mas a tab vinha vazia. Razão:
        // postsTotal = posts.length + reels.length, então quando o user só
        // tem reels, o contador era 2 mas o array `posts` vinha [].
        // Tab Posts agora mostra posts E reels combinados (ordenados desc),
        // assim o conteúdo aparece. Tab Reels segue só com reels.
        const combined = [...(posts || []), ...(reels || [])]
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        if (combined.length === 0) {
          return (
            <EmptyStateCard
              Icon={IconGrid}
              title={actions.is_self
                ? _ti('profile.empty.postsSelfTitle', 'Sem publicações ainda')
                : _ti('profile.empty.postsOtherTitle', 'Nenhuma publicação')}
              subtitle={actions.is_self
                ? _ti('profile.empty.postsSelfSub', 'Compartilhe sua primeira foto ou Reel.')
                : _ti('profile.empty.postsOtherSub', 'Quando publicar, vai aparecer aqui.')}
              ctaLabel={actions.is_self ? _ti('profile.empty.postsCta', 'Criar publicação') : undefined}
              onPress={actions.is_self ? () => router?.push('/feed?compose=1') : undefined}
            />
          );
        }
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {combined.map(p => (
              <GridItem
                key={`${p.id}-${p.type || ''}`}
                item={p}
                size={gridSize}
                isReel={p.type === 'video' || p.media_type === 'video'}
                onPress={() => handleOpenPost(p, p.type === 'video' || p.media_type === 'video' ? 'reels' : 'posts')}
              />
            ))}
          </View>
        );
      }
      if (activeTab === 'reels') {
        if (!reels.length) {
          return (
            <EmptyStateCard
              Icon={IconFilm}
              title={actions.is_self
                ? _ti('profile.empty.reelsSelfTitle', 'Nenhum Reel ainda')
                : _ti('profile.empty.reelsOtherTitle', 'Nenhum Reel')}
              subtitle={actions.is_self
                ? _ti('profile.empty.reelsSelfSub', 'Grave seu primeiro vídeo curto.')
                : _ti('profile.empty.reelsOtherSub', 'Os Reels aparecem aqui quando publicados.')}
              ctaLabel={actions.is_self ? _ti('profile.empty.reelsCta', 'Gravar Reel') : undefined}
              onPress={actions.is_self ? () => router?.push('/reels?compose=1') : undefined}
            />
          );
        }
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {reels.map(r => <GridItem key={r.id} item={r} size={gridSize} isReel onPress={() => handleOpenPost(r, 'reels')} />)}
          </View>
        );
      }
      if (activeTab === 'media') {
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {sharedMedia.map(m => <GridItem key={m.id} item={m} size={gridSize} onPress={() => handleOpenPost(m, 'media')} />)}
          </View>
        );
      }
      if (activeTab === 'chat') {
        return (
          <View>
            {commonChats.map(c => (
              <TouchableOpacity key={c.id}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border }}
                onPress={() => router?.push(`/chat-conversation?id=${c.id}`)}
              >
                <AvatarCircle name={c.name} size={42} />
                <Text style={{ flex: 1, fontSize: 15, color: colors?.text, fontWeight: '500' }}>{c.name}</Text>
                <IconChevronRight size={18} color={colors?.textTertiary} />
              </TouchableOpacity>
            ))}
          </View>
        );
      }
      if (activeTab === 'email') {
        return (
          <View>
            {emailPreview.map((e, idx) => (
              <TouchableOpacity
                key={`${e.folder}:${e.uid}:${idx}`}
                onPress={() => router?.push(`/read?uid=${e.uid}&folder=${encodeURIComponent(e.folder)}`)}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border }}
                activeOpacity={0.6}
              >
                <View style={{
                  width: 28, height: 28, borderRadius: 14, marginTop: 2,
                  backgroundColor: e.from_me ? '#7C3AED22' : (colors?.surface || '#f3f4f6'),
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconMail size={14} color={e.from_me ? '#7C3AED' : (colors?.text || '#111')} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, color: colors?.text, fontWeight: '600' }} numberOfLines={1}>
                    {e.subject || (t?.('reader.noSubject')) || '(no subject)'}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }} numberOfLines={1}>
                    {e.from_me ? (t?.('profile.sentByYou') || 'Enviado por você') : (t?.('profile.receivedFrom') || 'Recebido')}  ·  {e.date ? (_d => isNaN(_d.getTime()) ? '' : _d.toLocaleDateString())(new Date(e.date)) : ''}
                  </Text>
                </View>
                <IconChevronRight size={16} color={colors?.textTertiary} />
              </TouchableOpacity>
            ))}
          </View>
        );
      }
      return null;
    };

    return (
      <>
        {/* Sticky tabs — Instagram-style icons. Active = solid theme-text
            color icon + 1px bottom underline; inactive = muted gray icon
            with no underline. Falls back to text + count for contextual
            sections without a recognized icon (chat / email). */}
        <View style={{
          flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
          backgroundColor: colors?.background,
        }}>
          {tabs.map(tb => {
            const active = activeTab === tb.k;
            const Icon = tb.icon;
            const accent = colors?.text || '#0f172a';
            const muted = colors?.textTertiary || '#9ca3af';
            return (
              <TouchableOpacity key={tb.k} onPress={() => setActiveTab(tb.k)}
                accessibilityRole="tab"
                accessibilityLabel={tb.label}
                style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: active ? 1.5 : 0, borderBottomColor: accent }}
              >
                {Icon ? (
                  <Icon size={22} color={active ? accent : muted} />
                ) : (
                  <Text style={{ fontSize: 13, color: active ? accent : muted, fontWeight: active ? '700' : '500' }}>
                    {tb.label}
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {renderTabContent()}
      </>
    );
  };

  const body = loading ? (
    <ProfileSkeleton colors={colors} isDark={isDark} />
  ) : err ? (
    <View style={{ paddingHorizontal: 28, paddingTop: 80, paddingBottom: 40, alignItems: 'center' }}>
      <View style={{
        width: 72, height: 72, borderRadius: 36,
        backgroundColor: isDark ? 'rgba(239,68,68,0.14)' : 'rgba(239,68,68,0.10)',
        alignItems: 'center', justifyContent: 'center', marginBottom: 18,
      }}>
        {errStatus === 401
          ? <IconLock size={32} color={isDark ? '#fca5a5' : '#dc2626'} />
          : <IconAlertTriangle size={32} color={isDark ? '#fca5a5' : '#dc2626'} />}
      </View>
      <Text style={{ color: colors?.text, fontSize: 18, fontWeight: '700', marginBottom: 6, textAlign: 'center' }}>
        {errStatus === 401
          ? (t?.('profile.errSessionTitle') || 'Sessao expirada')
          : (t?.('profile.errLoadTitle') || 'Nao foi possivel carregar')}
      </Text>
      <Text style={{ color: colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)'), fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 24 }}>
        {errStatus === 401
          ? (t?.('profile.errSessionMsg') || 'Sua sessao expirou. Faca login de novo pra ver o perfil.')
          : (t?.('profile.errLoadMsg') || 'Verifique sua conexao e tente novamente.')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity
          onPress={() => { setErr(null); setErrStatus(0); setLoading(true); setRetryCounter(c => c + 1); }}
          style={{
            paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12,
            backgroundColor: '#7C3AED',
          }}
          accessibilityRole="button"
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
            {t?.('common.retry') || 'Tentar de novo'}
          </Text>
        </TouchableOpacity>
        {errStatus === 401 && onLogout ? (
          <TouchableOpacity
            onPress={() => { try { onLogout(); } catch {} }}
            style={{
              paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12,
              borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)',
            }}
            accessibilityRole="button"
          >
            <Text style={{ color: colors?.text, fontWeight: '700', fontSize: 14 }}>
              {t?.('common.signOut') || 'Sair'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  ) : (
    <>
      {renderHeader()}
      {/* renderStoriesRow removido — agora o ring fica ao redor do avatar
          principal (Instagram-style) e o tap abre direto o viewer. */}
      {mode === 'peek' ? renderPeekBody() : renderFullBody()}
    </>
  );

  // Swipeable post viewer — shared by both modes. Dataset varies by which
  // grid the user tapped (posts/reels/media). 'single' é fallback pra
  // quando o item clicado não tá em nenhum bucket (post veio de outro
  // endpoint) — abre o viewer com só esse item em vez de no-op.
  const viewerList = viewer.list === 'reels' ? reels
    : viewer.list === 'media' ? sharedMedia
    : viewer.list === 'single' && viewer.singleItem ? [viewer.singleItem]
    : posts;
  const viewerNode = (
    <ProfilePostViewer
      visible={viewer.open}
      posts={viewerList}
      startIndex={viewer.startIdx}
      author={identity ? { name: identity.name, email: identity.email } : null}
      onClose={() => setViewer(v => ({ ...v, open: false }))}
      colors={colors}
      isDark={isDark}
      t={t}
      router={router}
      user={currentUser}
    />
  );

  // Inline story viewer — opened from the highlights row at the top of the
  // profile. Replaces the old /chat?tab=status&viewStory=... deep-link that
  // chat.js never consumed (hence the white screen the user hit).
  const storyViewerNode = (
    <StoryViewer
      visible={storyViewer.open}
      stories={stories}
      startIdx={storyViewer.startIdx}
      ownerName={identity?.name || ''}
      ownerEmail={identity?.email || ''}
      onClose={() => setStoryViewer({ open: false, startIdx: 0 })}
      isSelf={!!actions?.is_self}
      t={t}
      onReply={async (story, text) => {
        // Reply = send a DM with quoted story context. Server accepts
        // status_id so the recipient's chat renders a "replied to story" card.
        try {
          const email = identity?.email;
          if (!email) return;
          await api.apiCall?.('status_reply', {
            status_id: story?.id,
            to_email: email,
            content: text,
          }, 'POST');
        } catch {}
      }}
      onReact={async (story, emoji) => {
        // Lightweight: server records the reaction + pings owner via WS.
        try {
          await api.apiCall?.('status_react', {
            status_id: story?.id,
            emoji,
          }, 'POST');
        } catch {}
      }}
      onDelete={async (statusId) => {
        try {
          await api.apiCall?.('status_delete', { status_id: statusId }, 'POST');
          setData(prev => prev ? { ...prev, stories: (prev.stories || []).filter(s => s.id !== statusId) } : prev);
          setStoryViewer({ open: false, startIdx: 0 });
        } catch {}
      }}
      onAddMore={async () => {
        // Launch image picker (native) or file input (web) and publish
        // directly. Avoids /chat?tab=status (white screen on mobile since
        // 'status' isn't in the bottom tab bar — indicator animation breaks).
        try {
          if (Platform.OS === 'web') {
            const input = typeof document !== 'undefined' ? document.createElement('input') : null;
            if (!input) return;
            input.type = 'file';
            input.accept = 'image/*,video/*';
            input.onchange = async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const uploadR = await api.statusUpload?.({ blob: f, name: f.name, type: f.type });
                if (uploadR?.success && uploadR.data?.url) {
                  const statusType = (f.type || '').startsWith('video') ? 'video' : 'image';
                  await api.statusPublish?.(uploadR.data.url, statusType, '#000000', null, {});
                  setData(prev => prev); // force re-render; next profile fetch picks up new story
                }
              } catch {}
            };
            input.click();
          } else {
            const ImagePicker = require('expo-image-picker');
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
            if (!perm?.granted) return;
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images', 'videos'],
              quality: 0.85,
            });
            if (result.canceled || !result.assets?.[0]) return;
            const a = result.assets[0];
            const file = { uri: a.uri, name: a.fileName || (a.type === 'video' ? 'status.mp4' : 'status.jpg'), type: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg') };
            const uploadR = await api.statusUpload?.(file);
            if (uploadR?.success && uploadR.data?.url) {
              const statusType = a.type === 'video' ? 'video' : 'image';
              await api.statusPublish?.(uploadR.data.url, statusType, '#000000', null, {});
            }
          }
        } catch (e) {
          console.warn('[story.addMore]', e?.message);
        }
      }}
    />
  );

  const menuNode = !actions.is_self && identity ? (
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }} onPress={() => setMenuOpen(false)}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            paddingBottom: Platform.OS === 'ios' ? 30 : 14,
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          <TouchableOpacity onPress={handleShareProfile} style={menuItemStyle(colors)}>
            <IconShare size={20} color={colors?.text} />
            <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>
              {t?.('profile.share') || 'Compartilhar perfil'}
            </Text>
          </TouchableOpacity>
          {identity?.email && identity.email !== currentUser?.email && (
            <TouchableOpacity
              onPress={() => {
                setMenuOpen(false);
                const current = typeof window !== 'undefined' && window.prompt
                  ? window.prompt(t?.('profile.nicknamePrompt') || 'Como você quer chamar essa pessoa? (deixa vazio pra remover)', nicknameValue || '')
                  : null;
                // Native: use Alert.prompt (iOS only) or inline modal — fallback
                // to a simple alert telling the user to edit via a future modal.
                if (typeof window !== 'undefined' && current !== null) {
                  (async () => {
                    try {
                      const api = require('../services/api');
                      const { setNicknameLocal } = require('../services/nicknames');
                      const val = String(current || '').trim();
                      await api.chatNicknameSet(identity.email, val);
                      setNicknameLocal(identity.email, val);
                      setNicknameValue(val);
                    } catch {}
                  })();
                } else if (Platform.OS === 'ios') {
                  try {
                    Alert.prompt(
                      t?.('profile.nickname') || 'Apelido',
                      t?.('profile.nicknameHint') || 'Só você vê este nome.',
                      [
                        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                        { text: t?.('common.save') || 'Salvar', onPress: async (txt) => {
                          try {
                            const api = require('../services/api');
                            const { setNicknameLocal } = require('../services/nicknames');
                            const val = String(txt || '').trim();
                            await api.chatNicknameSet(identity.email, val);
                            setNicknameLocal(identity.email, val);
                            setNicknameValue(val);
                          } catch {}
                        }},
                      ],
                      'plain-text', nicknameValue || ''
                    );
                  } catch {}
                }
              }}
              style={menuItemStyle(colors)}
            >
              <IconEdit3 size={20} color={colors?.text} />
              <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>
                {nicknameValue
                  ? `${t?.('profile.nicknameEdit') || 'Editar apelido'}: ${nicknameValue}`
                  : (t?.('profile.nicknameAdd') || 'Adicionar apelido')}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleBlock} style={menuItemStyle(colors)}>
            <IconLock size={20} color={colors?.text} />
            <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>
              {t?.('profile.block') || 'Bloquear'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleReport} style={menuItemStyle(colors)}>
            <IconAlertTriangle size={20} color="#ef4444" />
            <Text style={{ fontSize: 15, color: '#ef4444', fontWeight: '500' }}>
              {t?.('profile.report') || 'Denunciar'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMenuOpen(false)} style={{ alignItems: 'center', paddingVertical: 14, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors?.border }}>
            <Text style={{ fontSize: 15, color: colors?.textSecondary }}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  ) : null;

  // Inline self-profile edit. Updates identity locally on save so the UI
  // reflects the change without another network round-trip.
  const editNode = actions.is_self ? (
    <ProfileEditSheet
      visible={editOpen}
      onClose={() => setEditOpen(false)}
      initial={identity}
      currentEmail={identity?.email}
      onSaved={(next) => {
        setData(prev => prev ? { ...prev, identity: { ...prev.identity, ...next } } : prev);
        // Bust cache so the new bio/name shows on the next open from
        // anywhere else in the app (sidebar, chat header, /u/...).
        invalidateProfileCache(fetchKey);
      }}
      colors={colors}
      isDark={isDark}
      t={t}
    />
  ) : null;

  // Followers / Following list sheet — opened when the Stat row taps on
  // "Seguidores" or "Seguindo". Instagram pattern: two tabs in one sheet.
  const followersNode = identity ? (
    <FollowersSheet
      visible={!!followersTab}
      email={identity.email}
      initialTab={followersTab || 'followers'}
      colors={colors}
      isDark={isDark}
      t={t}
      onClose={() => setFollowersTab(null)}
      router={router}
    />
  ) : null;

  // Self-only settings bottom sheet. Lives inside Profile so the "Editar
  // perfil" row can open the inline edit sheet directly — the previous
  // implementation pushed /profile?edit=1 which is a redirect stub and
  // silently dropped the edit=1 query param.
  const settingsNode = actions.is_self ? (
    <ProfileSettingsSheet
      visible={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      colors={colors}
      isDark={isDark}
      t={t}
      router={router}
      userEmail={identity?.email}
      onEditProfile={() => setEditOpen(true)}
      onLogout={async () => {
        try {
          if (onLogout) await onLogout();
          else if (authLogout) { await authLogout(); router?.replace?.('/login'); }
        } catch {}
      }}
    />
  ) : null;

  // ─── Render ──────────────────────────────────────────────────────────
  if (mode === 'full') {
    return (
      <>
        <ScrollView style={{ flex: 1, backgroundColor: colors?.background }}
          contentContainerStyle={{ paddingBottom: 60 }}
        >
          {body}
        </ScrollView>
        {viewerNode}
        {storyViewerNode}
        {editNode}
        {settingsNode}
        {followersNode}
        {menuNode}
      </>
    );
  }

  // peek mode — modal bottom-sheet with swipe-down-to-dismiss.
  // Why: native iOS sheets and WhatsApp/IG profile peek both let the user
  // drag the sheet down to close. The pan-responder lives on the top
  // grab-handle row only so the scrollable body underneath keeps working.
  return <PeekSheet
    visible={!!visible}
    onClose={onClose}
    colors={colors}
    isDark={isDark}
    body={body}
    extras={<>
      {viewerNode}
      {storyViewerNode}
      {editNode}
      {settingsNode}
      {followersNode}
      {menuNode}
    </>}
  />;
}

// PeekSheet — extracted for clarity. Owns the slide-down translate/opacity
// animation and the pan responder that drives swipe-to-close. Threshold
// (>110px or velocity >0.6) commits to dismiss; below that snaps back.
function PeekSheet({ visible, onClose, colors, isDark, body, extras }) {
  const SH = Dimensions.get('window').height;
  const translateY = useRef(new Animated.Value(0)).current;
  const backdropOpacity = useRef(new Animated.Value(1)).current;
  // Drives the inverse fade (closer to bottom = more transparent backdrop)
  // so the dismiss feels like one fluid gesture.
  const _commitClose = () => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: SH, duration: 220, easing: Easing.bezier(0.55, 0.06, 0.68, 0.19), useNativeDriver: true }),
      Animated.timing(backdropOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      try { onClose?.(); } catch {}
      // Reset for next mount; otherwise the next open animates from offscreen.
      translateY.setValue(0);
      backdropOpacity.setValue(1);
    });
  };
  const _snapBack = () => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, friction: 8, tension: 90, useNativeDriver: true }),
      Animated.timing(backdropOpacity, { toValue: 1, duration: 160, useNativeDriver: true }),
    ]).start();
  };
  // Only handle vertical drags >5px so taps still fire. Horizontal drags
  // (e.g. avatar swipes) are ignored — caller's stopPropagation still works.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => {
        if (g.dy < 0) return; // ignore upward drag
        translateY.setValue(g.dy);
        // Backdrop fades from 1 → 0 across ~SH/2 of drag.
        const op = Math.max(0, 1 - (g.dy / (SH * 0.5)));
        backdropOpacity.setValue(op);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 110 || g.vy > 0.6) _commitClose(); else _snapBack();
      },
      onPanResponderTerminate: () => _snapBack(),
    })
  ).current;

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', opacity: backdropOpacity }}>
        <Pressable style={{ flex: 1 }} onPress={_commitClose} />
        <Animated.View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '88%',
            transform: [{ translateY }],
          }}
        >
          {/* Drag-handle row owns the pan-responder. Swipe down to dismiss.
              Body ScrollView underneath stays scrollable independently. */}
          <View
            {...panResponder.panHandlers}
            style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 8 }}
          >
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          {/* Close (X) — kept for non-gesture dismissal (web, accessibility) */}
          <TouchableOpacity onPress={_commitClose} style={{ position: 'absolute', right: 12, top: 10, padding: 8, zIndex: 10 }}>
            <IconX size={20} color={colors?.textSecondary || '#888'} />
          </TouchableOpacity>
          <ScrollView showsVerticalScrollIndicator={false}>{body}</ScrollView>
        </Animated.View>
      </Animated.View>
      {extras}
    </Modal>
  );
}
