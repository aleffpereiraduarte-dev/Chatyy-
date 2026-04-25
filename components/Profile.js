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
} from 'react-native';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from './AvatarCircle';
import ProfilePostViewer from './ProfilePostViewer';
import ProfileEditSheet from './ProfileEditSheet';
import ProfileSettingsSheet from './ProfileSettingsSheet';
import FollowersSheet from './FollowersSheet';
import {
  IconX, IconPhone, IconVideo, IconMail, IconMessageSquare, IconUserPlus,
  IconChevronRight, IconSettings, IconMoreHorizontal, IconShare, IconAlertTriangle, IconLock, IconEdit,
  IconTrash, IconPlus,
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
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={!onPress}
      style={{ flex: 1, alignItems: 'center' }}
    >
      <Text style={{ fontSize: 18, fontWeight: '700', color: colors?.text }}>
        {formatCount(value)}
      </Text>
      <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Grid item (post thumb) ──────────────────────────────────────────
// Uses expo-image on native for disk-cached thumbs so scrolling back into a
// profile doesn't re-download every tile. Web falls back to native <img>
// (browser cache handles persistence).
function GridItem({ item, size, onPress, isReel }) {
  const url = resolveMedia(item.thumbnail || item.url || '');
  // Server's `thumbnail` falls back to media_urls[0] when no real poster was
  // generated — for reels that's the video URL. Detect and use <video> so the
  // browser pulls the first frame as a poster instead of broken-img.
  const looksLikeVideo = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(url)
    || item.type === 'video' || item.media_type === 'video' || isReel;
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
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3, background: '#111' }}
          />
        );
      }
      return <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3 }} alt="" loading="lazy" decoding="async" />;
    }
    if (looksLikeVideo) {
      // expo-image can't decode video frames; show dark placeholder with the
      // video badge already rendered below.
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

// ─── Inline story viewer ─────────────────────────────────────────────
// Full-screen Modal with progress bars, tap-left/tap-right nav, auto-advance
// for images/text, and onEnd for videos. Marks each story viewed via
// api.statusView when first shown. Stays inside Profile so we never bounce
// the user out to /chat for something that belongs on the profile itself.
const STORY_DURATION_MS = 5000;

function InlineStoryViewer({ visible, stories, startIdx, ownerName, ownerEmail, onClose, isSelf = false, onDelete, onAddMore, onReply, onReact, t }) {
  const [idx, setIdx] = useState(startIdx || 0);
  const [paused, setPaused] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [reactPop, setReactPop] = useState(null); // emoji that just flew up
  const progressRef = useRef(new Animated.Value(0));
  const animRef = useRef(null);
  const viewedIdsRef = useRef(new Set());

  useEffect(() => {
    if (visible) {
      setIdx(Math.min(Math.max(0, startIdx || 0), Math.max(0, (stories?.length || 1) - 1)));
      setPaused(false);
    }
  }, [visible, startIdx, stories?.length]);

  const advance = useCallback(() => {
    setIdx(prev => {
      if (prev < (stories?.length || 0) - 1) return prev + 1;
      onClose?.();
      return prev;
    });
  }, [stories, onClose]);

  // Drive the top progress bar for the current story, and auto-advance when
  // it reaches 100%. Videos skip this (they advance via onEnd).
  useEffect(() => {
    if (!visible) return;
    const cur = stories?.[idx];
    if (!cur) return;
    progressRef.current.setValue(0);
    // Mark viewed once per session
    if (cur.id && !viewedIdsRef.current.has(cur.id)) {
      viewedIdsRef.current.add(cur.id);
      try { api.statusView?.(cur.id); } catch {}
    }
    if (cur.type === 'video') return; // video drives its own timing
    if (paused) return;
    animRef.current = Animated.timing(progressRef.current, {
      toValue: 1,
      duration: STORY_DURATION_MS,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished) advance();
    });
    return () => { animRef.current?.stop?.(); };
  }, [visible, idx, paused, stories, advance]);

  if (!visible) return null;
  const cur = stories?.[idx];
  if (!cur) return null;
  // Fallback for legacy rows where image/video URLs were accidentally
  // written to `content` instead of `media_url`. The DB was migrated but
  // this guards against stale cached responses still carrying the old
  // shape. Detects a URL-ish content (starts with / or http) when type is
  // image/video and media_url is empty.
  const rawMedia = cur.media_url
    || ((cur.type === 'image' || cur.type === 'video') && /^(\/|https?:\/\/)/.test(String(cur.content || ''))
        ? cur.content
        : '');
  const mediaUrl = rawMedia ? (rawMedia.startsWith('http') ? rawMedia : `${BASE_URL}${rawMedia}`) : '';

  const renderMedia = () => {
    if (cur.type === 'text' || !mediaUrl) {
      return (
        <View style={{ flex: 1, backgroundColor: cur.bg_color || '#25D366', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center', lineHeight: 34 }}>
            {cur.content || ''}
          </Text>
        </View>
      );
    }
    if (cur.type === 'video') {
      // Boomerang: short 1.5s clip that we loop for ~7s so it plays 4-5 times.
      // True back-and-forth playback would need a frame-reverse encode; looping
      // the clip is the cheap client-side approximation that matches Instagram
      // boomerang UX closely enough.
      const isBoomerang = !!cur.is_boomerang || !!cur?.meta?.is_boomerang;
      const boomerangLoopDurationMs = 7000;
      if (WEB) {
        return (
          <video
            src={mediaUrl}
            autoPlay
            playsInline
            loop={isBoomerang}
            onEnded={isBoomerang ? undefined : advance}
            onLoadedMetadata={isBoomerang ? (() => setTimeout(advance, boomerangLoopDurationMs)) : undefined}
            style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
          />
        );
      }
      let V = null;
      try { V = require('expo-av').Video; } catch {}
      if (V) {
        return (
          <V
            source={{ uri: mediaUrl }}
            resizeMode="contain"
            shouldPlay={!paused}
            isLooping={isBoomerang}
            onLoad={isBoomerang ? (() => setTimeout(advance, boomerangLoopDurationMs)) : undefined}
            onPlaybackStatusUpdate={(s) => { if (!isBoomerang && s?.didJustFinish) advance(); }}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
          />
        );
      }
      // Fallback to image preview
      return <Image source={{ uri: mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
    }
    // image
    if (_ExpoImage && !WEB) {
      return (
        <_ExpoImage
          source={{ uri: mediaUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      );
    }
    return WEB
      ? <img src={mediaUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
      : <Image source={{ uri: mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Progress bars */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 0, right: 0,
          flexDirection: 'row', gap: 4, paddingHorizontal: 10, zIndex: 5,
        }}>
          {stories.map((_, i) => (
            <View key={i} style={{ flex: 1, height: 2.5, backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 2, overflow: 'hidden' }}>
              {i < idx && <View style={{ width: '100%', height: '100%', backgroundColor: '#fff' }} />}
              {i === idx && (
                <Animated.View style={{
                  height: '100%',
                  backgroundColor: '#fff',
                  width: progressRef.current.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                }} />
              )}
            </View>
          ))}
        </View>

        {/* Header */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 64 : 34, left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, zIndex: 5,
        }}>
          <Text style={{ flex: 1, color: '#fff', fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
            {ownerName}
          </Text>
          {isSelf && cur?.id && (
            <>
              <TouchableOpacity
                onPress={() => {
                  const id = cur.id;
                  const doDelete = () => { onDelete?.(id); };
                  if (Platform.OS === 'web') {
                    if (typeof window !== 'undefined' && window.confirm(t?.('status.deleteConfirm') || 'Apagar este status?')) doDelete();
                  } else {
                    Alert.alert(
                      t?.('status.deleteTitle') || 'Apagar status',
                      t?.('status.deleteConfirm') || 'Apagar este status?',
                      [
                        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                        { text: t?.('common.delete') || 'Excluir', style: 'destructive', onPress: doDelete },
                      ]
                    );
                  }
                }}
                style={{ padding: 8, marginRight: 4 }}
                accessibilityLabel={t?.('common.delete') || 'Excluir'}
              >
                <IconTrash2 size={22} color="#ef4444" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { onClose?.(); setTimeout(() => onAddMore?.(), 150); }}
                style={{ padding: 8, marginRight: 4 }}
                accessibilityLabel={t?.('status.addMore') || 'Adicionar outro'}
              >
                <IconPlus size={22} color="#fff" />
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }} accessibilityLabel="Close">
            <IconX size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Media */}
        <View style={{ flex: 1 }}>
          {renderMedia()}
        </View>

        {/* Tap zones — leave room at the bottom for the reply bar so taps in
            the input don't register as "next story". 80px buffer mirrors Instagram. */}
        <Pressable
          style={{ position: 'absolute', left: 0, top: 110, bottom: 80, width: '30%' }}
          onPress={() => setIdx(i => Math.max(0, i - 1))}
        />
        <Pressable
          style={{ position: 'absolute', right: 0, top: 110, bottom: 80, width: '30%' }}
          onPress={advance}
        />
        <Pressable
          style={{ position: 'absolute', left: '30%', right: '30%', top: 110, bottom: 80 }}
          onPressIn={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />

        {/* Flying emoji animation — shows briefly when a quick reaction fires */}
        {reactPop && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, right: 0, bottom: 100,
            alignItems: 'center', zIndex: 20,
          }}>
            <Text style={{ fontSize: 72 }}>{reactPop}</Text>
          </View>
        )}

        {/* Bottom bar — Instagram pattern:
            - Other's story: reply input + emoji quick-reactions
            - Own story: "Visto por N" counter + eye icon  */}
        <View style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingHorizontal: 14, paddingBottom: Platform.OS === 'ios' ? 28 : 14, paddingTop: 10,
          backgroundColor: 'rgba(0,0,0,0.15)',
          zIndex: 10,
        }}>
          {isSelf ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', opacity: 0.9 }}>
                👁  {(cur?.views ?? 0)} {cur?.views === 1 ? (t?.('status.view') || 'visualização') : (t?.('status.views') || 'visualizações')}
              </Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {/* Quick reactions row */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {['❤️','🔥','😂','😮','😢','👏','👍'].map(emoji => (
                  <TouchableOpacity
                    key={emoji}
                    onPress={() => {
                      setReactPop(emoji);
                      setTimeout(() => setReactPop(null), 900);
                      try { onReact?.(cur, emoji); } catch {}
                    }}
                    hitSlop={8}
                    style={{ paddingHorizontal: 6 }}
                  >
                    <Text style={{ fontSize: 26 }}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {/* Reply input */}
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                backgroundColor: 'rgba(255,255,255,0.12)',
                borderRadius: 24, paddingLeft: 16, paddingRight: 6,
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
              }}>
                <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>✉</Text>
                <TextInput
                  value={replyText}
                  onChangeText={setReplyText}
                  onFocus={() => setPaused(true)}
                  onBlur={() => setPaused(false)}
                  placeholder={(t?.('status.replyPlaceholder') || 'Responder para') + ' ' + (ownerName || '...')}
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  style={{ flex: 1, color: '#fff', fontSize: 14, paddingVertical: 10, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
                  editable={!replying}
                />
                {replyText.trim() ? (
                  <TouchableOpacity
                    disabled={replying}
                    onPress={async () => {
                      if (!replyText.trim() || replying) return;
                      setReplying(true);
                      try { await onReply?.(cur, replyText.trim()); } catch {}
                      setReplyText('');
                      setReplying(false);
                    }}
                    style={{
                      width: 34, height: 34, borderRadius: 17,
                      backgroundColor: '#7C3AED',
                      alignItems: 'center', justifyContent: 'center',
                      opacity: replying ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>→</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
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
  const [activeTab, setActiveTab] = useState('posts');
  const [viewer, setViewer] = useState({ open: false, startIdx: 0, list: 'posts' });
  const [storyViewer, setStoryViewer] = useState({ open: false, startIdx: 0 });
  const [editOpen, setEditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
          setErr(r?.message || 'Failed to load profile');
        }
      } catch (e) {
        if (!cancelled && !cached) setErr(e?.message || 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchKey, visible, mode]);

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
    const list = listName === 'reels' ? reels : (listName === 'media' ? sharedMedia : posts);
    const idx = list.findIndex(p => p.id === item.id);
    setViewer({ open: true, startIdx: Math.max(0, idx), list: listName });
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
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#1DA1F2', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '900' }}>✓</Text>
              </View>
            )}
          </View>
          {actions.is_self && (
            <TouchableOpacity onPress={() => (onOpenSettings ? onOpenSettings() : setSettingsOpen(true))} style={{ padding: 6 }} accessibilityLabel={t?.('settings.title') || 'Settings'}>
              <IconSettings size={24} color={colors?.text} />
            </TouchableOpacity>
          )}
          {!actions.is_self && (
            <TouchableOpacity onPress={() => setMenuOpen(true)} style={{ padding: 6 }} accessibilityLabel="More">
              <IconMoreHorizontal size={24} color={colors?.text} />
            </TouchableOpacity>
          )}
        </View>

        {/* Row 2 — avatar + stats laid out horizontally */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
          <AvatarCircle name={identity.name} email={identity.email} size={86} />
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
    const tabs = [
      { k: 'posts', label: t?.('profile.posts') || 'Posts', count: posts.length },
      { k: 'reels', label: t?.('profile.reels') || 'Reels', count: reels.length },
      !actions.is_self && { k: 'media', label: t?.('profile.media') || 'Mídia', count: sharedMedia.length },
      !actions.is_self && { k: 'chat',  label: t?.('profile.chat') || 'Conversas', count: commonChats.length },
      !actions.is_self && emailPreview.length > 0 && { k: 'email', label: t?.('profile.email') || 'Email', count: emailPreview.length },
    ].filter(Boolean);

    const renderTabContent = () => {
      if (activeTab === 'posts') {
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {posts.map(p => <GridItem key={p.id} item={p} size={gridSize} onPress={() => handleOpenPost(p)} />)}
          </View>
        );
      }
      if (activeTab === 'reels') {
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
                    {e.from_me ? (t?.('profile.sentByYou') || 'Enviado por você') : (t?.('profile.receivedFrom') || 'Recebido')}  ·  {e.date ? new Date(e.date).toLocaleDateString() : ''}
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
        {/* Sticky tabs */}
        <View style={{
          flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
          backgroundColor: colors?.background,
        }}>
          {tabs.map(tb => {
            const active = activeTab === tb.k;
            return (
              <TouchableOpacity key={tb.k} onPress={() => setActiveTab(tb.k)}
                style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: active ? 2 : 0, borderBottomColor: '#7C3AED' }}
              >
                <Text style={{ fontSize: 13, color: active ? '#7C3AED' : colors?.textSecondary, fontWeight: active ? '700' : '500' }}>
                  {tb.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {renderTabContent()}
      </>
    );
  };

  const body = loading ? (
    <View style={{ padding: 40, alignItems: 'center' }}>
      <ActivityIndicator color="#7C3AED" />
    </View>
  ) : err ? (
    <View style={{ padding: 30, alignItems: 'center' }}>
      <Text style={{ color: colors?.text }}>{err}</Text>
    </View>
  ) : (
    <>
      {renderHeader()}
      {renderStoriesRow()}
      {mode === 'peek' ? renderPeekBody() : renderFullBody()}
    </>
  );

  // Swipeable post viewer — shared by both modes. Dataset varies by which
  // grid the user tapped (posts/reels/media).
  const viewerList = viewer.list === 'reels' ? reels : (viewer.list === 'media' ? sharedMedia : posts);
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
    <InlineStoryViewer
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

  // peek mode — modal bottom-sheet
  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '88%',
          }}
          onPress={e => e.stopPropagation?.()}
        >
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          {/* Close */}
          <TouchableOpacity onPress={onClose} style={{ position: 'absolute', right: 12, top: 10, padding: 8, zIndex: 10 }}>
            <IconX size={20} color={colors?.textSecondary || '#888'} />
          </TouchableOpacity>
          <ScrollView showsVerticalScrollIndicator={false}>{body}</ScrollView>
        </Pressable>
      </Pressable>
      {viewerNode}
      {storyViewerNode}
      {editNode}
      {settingsNode}
      {followersNode}
      {menuNode}
    </Modal>
  );
}
