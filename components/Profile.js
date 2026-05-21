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
  PanResponder, Easing, Switch, Linking, AppState, DeviceEventEmitter,
} from 'react-native';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from './AvatarCircle';
import AvatarLightbox from './AvatarLightbox';
import StoryRingAvatar from './status/StoryRingAvatar';
import StoryViewer from './status/StoryViewer';
import StatusCamera from './StatusCamera';
import ProfilePostViewer from './ProfilePostViewer';
import ProfileEditSheet from './ProfileEditSheet';
import ProfileSettingsSheet from './ProfileSettingsSheet';
import FollowersSheet from './FollowersSheet';
import EmptyStateCard from './EmptyStateCard';
import SendDiamondSheet from './SendDiamondSheet';
import HighlightEditSheet from './HighlightEditSheet';
import HighlightShareSheet from './HighlightShareSheet';
import {
  IconX, IconPhone, IconVideo, IconMail, IconMessageSquare, IconUserPlus,
  IconChevronRight, IconSettings, IconMoreHorizontal, IconShare, IconAlertTriangle, IconLock, IconEdit,
  IconTrash, IconPlus, IconGrid, IconFilm, IconTag, IconCheck, IconEyeOff, IconLink, IconPlay,
  IconGiftBox,
} from './Icons';
const IconEdit3 = IconEdit;
const IconTrash2 = IconTrash;

// Gradient halo + empty illustration. Loaded lazily so a missing peer dep
// can't crash the screen — fall back to plain View borders when unavailable.
let _Svg = null, _SvgDefs = null, _SvgLinearGradient = null, _SvgStop = null, _SvgCircle = null, _SvgPath = null;
try {
  const _svg = require('react-native-svg');
  _Svg = _svg.Svg || _svg.default;
  _SvgDefs = _svg.Defs;
  _SvgLinearGradient = _svg.LinearGradient;
  _SvgStop = _svg.Stop;
  _SvgCircle = _svg.Circle;
  _SvgPath = _svg.Path;
} catch (e) {}

const WEB = Platform.OS === 'web';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Stale-while-revalidate cache for profile_get. Keyed by the email-or-username
// argument. Two layers:
//   1. In-memory Map — instant within a session.
//   2. MMKV — persists across cold starts so cold-open paints from disk and
//      the screen never sits on a spinner when offline (was the bug: user
//      reported "perfil só fica carregando, não salva cache").
const _profileCache = new Map(); // key -> { data, ts }
const PROFILE_TTL_MS = 2 * 60 * 1000; // 2 min — fresh enough for presence
const PROFILE_MMKV_PREFIX = 'profile_v1:';

let _mmkv = null;
function _getMmkv() {
  if (_mmkv) return _mmkv;
  try { _mmkv = require('../services/mmkv'); } catch {}
  return _mmkv;
}

function _mmkvKey(key) {
  return PROFILE_MMKV_PREFIX + String(key).toLowerCase();
}

export function invalidateProfileCache(key) {
  if (key == null) {
    _profileCache.clear();
    try {
      const mmkv = _getMmkv();
      mmkv?.getAllKeys?.()?.forEach?.(k => {
        if (k.startsWith(PROFILE_MMKV_PREFIX)) mmkv.remove?.(k);
      });
    } catch {}
    return;
  }
  const k = String(key).toLowerCase();
  _profileCache.delete(k);
  try { _getMmkv()?.remove?.(_mmkvKey(k)); } catch {}
}

function _cacheGet(key) {
  if (!key) return null;
  const id = String(key).toLowerCase();
  const hit = _profileCache.get(id);
  if (hit) return hit;
  // Hydrate from MMKV on demand.
  try {
    const stored = _getMmkv()?.getJSON?.(_mmkvKey(id));
    if (stored && stored.data) {
      _profileCache.set(id, stored);
      return stored;
    }
  } catch {}
  return null;
}

function _cacheSet(key, data) {
  if (!key) return;
  const entry = { data, ts: Date.now() };
  _profileCache.set(String(key).toLowerCase(), entry);
  try { _getMmkv()?.setJSON?.(_mmkvKey(key), entry); } catch {}
}

// Lazy expo-image for disk-cached grid/story thumbnails (avoids blank flicker
// when re-opening a profile). Falls back to react-native Image if unavailable.
let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}

// ─── Small helpers ────────────────────────────────────────────────────
// Stat counter formatter — Instagram parity:
//   < 1k       → bare number  (e.g. 842)
//   1k–9.99k   → comma-grouped (e.g. 1,234)        ← keeps full fidelity for
//                                                    most "discover-tier" users
//   ≥ 10k      → compact suffix (e.g. 12.3k, 1.5M) ← avoids 5+ digit blow-out
// Uses Intl when present, hand-rolled regex fallback so the screen renders on
// older RN runtimes that ship without full ICU.
function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1).replace('.0', '') + 'k';
  if (n >= 1_000) {
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
        return new Intl.NumberFormat().format(n);
      }
    } catch {}
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
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
// Instagram-style pill button: 50% width, fully rounded corners, bold label.
//   - Primary  → solid purple fill, no border, soft elevation shadow.
//   - Secondary → transparent fill with 1px brand-tinted border (outlined pill).
// Press feels tactile via a spring scale (native driver). The shadow is
// kept subtle (purple alpha, low offset) so it doesn't clash with dark mode.
function FlatButton({ label, onPress, isPrimary, colors, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, speed: 30, bounciness: 4 }).start();
  }, [scale]);
  const onPressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 8 }).start();
  }, [scale]);
  // Outline color: brand tint on light mode, lighter brand on dark. Falls
  // back to colors.border when the brand isn't appropriate (e.g. very dim
  // surfaces) — but we generally want the secondary to hint at brand.
  const outlineColor = isDark ? 'rgba(167,139,250,0.55)' : 'rgba(124,58,237,0.30)';
  return (
    <Animated.View style={{
      flex: 1,
      transform: [{ scale }],
      // Soft purple glow only for the primary CTA — Instagram-grade lift.
      ...(isPrimary && Platform.OS !== 'web' ? {
        shadowColor: '#5B21B6',
        shadowOpacity: isDark ? 0.45 : 0.30,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 4,
      } : {}),
    }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          paddingVertical: 11,
          paddingHorizontal: 14,
          borderRadius: 999, // pill
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isPrimary ? '#7C3AED' : 'transparent',
          borderWidth: isPrimary ? 0 : 1,
          borderColor: isPrimary ? 'transparent' : outlineColor,
        }}
      >
        <Text style={{
          fontSize: 14,
          fontWeight: '700',
          letterSpacing: 0.1,
          color: isPrimary ? '#fff' : (colors?.text || (isDark ? '#fff' : '#111')),
        }} numberOfLines={1}>
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// Live "Watch now" CTA — full-width red pulsing pill that surfaces a host's
// active broadcast directly on their profile, just below the action row.
// Instagram parity: when a friend is live, the only action that matters is
// joining the stream, so this gets visual priority over Mensagem/Ligar/etc.
//
// Implementation notes:
//   - native driver scale loop on the wrapping container so the pill feels
//     alive without forcing a layout pass each frame
//   - inner dot pulses opacity at 800ms (slightly faster than the outer
//     scale) so it reads as a heartbeat, not a single sluggish breath
//   - the press scale is layered on top of the loop via Animated.add so the
//     tap feedback still works while the heartbeat is running
function LiveWatchCta({ label, onPress }) {
  const breath = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);
  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] });
  const pressScale = press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] });
  const dotPulse = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] });
  return (
    <Animated.View style={{
      transform: [{ scale: breathScale }, { scale: pressScale }],
      ...(Platform.OS !== 'web' ? {
        shadowColor: '#dc2626',
        shadowOpacity: 0.55,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
      } : { boxShadow: '0 6px 18px rgba(220,38,38,0.45), 0 0 0 1px rgba(220,38,38,0.25)' }),
      borderRadius: 14,
    }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={() => Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 4 }).start()}
        onPressOut={() => Animated.spring(press, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 8 }).start()}
        activeOpacity={0.9}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          paddingVertical: 13,
          paddingHorizontal: 16,
          borderRadius: 14,
          backgroundColor: '#dc2626',
        }}
      >
        <View style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: 'rgba(255,255,255,0.18)',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Animated.View style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: '#fff',
            opacity: dotPulse,
          }} />
        </View>
        <Text style={{
          fontSize: 14.5,
          fontWeight: '800',
          color: '#fff',
          letterSpacing: 0.3,
        }}>
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// Secondary chip with icon + label — used for supplementary actions (call,
// video, email) that sit below the primary Follow/Message row. Pill-shape
// matches the FlatButton above so the action stack reads as one family.
function ChipButton({ icon: Icon, label, onPress, colors, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  const outlineColor = isDark ? 'rgba(167,139,250,0.40)' : 'rgba(124,58,237,0.22)';
  return (
    <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={() => Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, speed: 30, bounciness: 4 }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 8 }).start()}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingVertical: 9,
          paddingHorizontal: 12,
          borderRadius: 999, // pill
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderColor: outlineColor,
        }}
      >
        {Icon && <Icon size={15} color={colors?.text || (isDark ? '#fff' : '#111')} />}
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors?.text || (isDark ? '#fff' : '#111') }} numberOfLines={1}>
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
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
  //
  // Press affordance: spring-down to 0.94 on touch-in, spring back on release.
  // Native driver so it stays buttery on lower-end Androids. Also bumps the
  // hit-target via hitSlop so the 36-tall column never falls below the iOS
  // 44pt accessibility floor.
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() => {
    if (!onPress) return;
    Animated.spring(scale, { toValue: 0.94, useNativeDriver: true, speed: 28, bounciness: 6 }).start();
  }, [onPress, scale]);
  const onPressOut = useCallback(() => {
    if (!onPress) return;
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 10 }).start();
  }, [onPress, scale]);
  return (
    <TouchableOpacity
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={0.85}
      disabled={!onPress}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `${label}: ${formatCount(value)}` : undefined}
      style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }}
    >
      {/* Instagram parity: number 18/700 above label 13/500. Tabular-nums
          locks digit width so 1.2K → 1.3K doesn't shift the column. */}
      <Animated.View style={{ alignItems: 'center', transform: [{ scale }] }}>
        <Text style={{
          fontSize: 18, fontWeight: '700', color: colors?.text, letterSpacing: -0.3,
          fontVariant: ['tabular-nums'],
        }}>
          {formatCount(value)}
        </Text>
        <Text style={{
          fontSize: 13, color: colors?.text, marginTop: 2,
          letterSpacing: 0, fontWeight: '400',
          opacity: 0.85,
        }}>
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Empty-state illustration ─────────────────────────────────────────
// Subtle 3-tile-mosaic SVG that lives where the posts grid would be.
// Reads as "no photos here yet" without leaning on a literal camera icon.
// Renders at very low opacity so it sinks into the background — the title
// and CTA stay the focal point.
function EmptyGridIllustration({ isDark, size = 120 }) {
  if (!_Svg || !_SvgPath) {
    // Fallback: stack of 3 dim squares laid out the same way.
    const tile = (size - 14) / 2;
    const tone = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)';
    return (
      <View style={{ width: size, height: size, opacity: 0.85 }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <View style={{ width: tile, height: tile, borderRadius: 10, backgroundColor: tone }} />
          <View style={{ width: tile, height: tile, borderRadius: 10, backgroundColor: tone, opacity: 0.7 }} />
        </View>
        <View style={{ flexDirection: 'row', marginTop: 6 }}>
          <View style={{ width: tile, height: tile, borderRadius: 10, backgroundColor: tone, opacity: 0.55 }} />
        </View>
      </View>
    );
  }
  const tone = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)';
  const accent = isDark ? 'rgba(167,139,250,0.30)' : 'rgba(124,58,237,0.20)';
  return (
    <_Svg width={size} height={size} viewBox="0 0 120 120">
      {/* Two mosaic tiles + one accent tile in brand purple */}
      <_SvgPath d="M14 14 H56 V56 H14 Z" fill={tone} />
      <_SvgPath d="M64 14 H106 V56 H64 Z" fill={tone} opacity={0.7} />
      <_SvgPath d="M14 64 H56 V106 H14 Z" fill={accent} />
      {/* Small "plus" hint inside accent tile */}
      <_SvgPath
        d="M35 78 V92 M28 85 H42"
        stroke={isDark ? '#C084FC' : '#7C3AED'}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <_SvgPath d="M64 64 H106 V106 H64 Z" fill={tone} opacity={0.45} />
    </_Svg>
  );
}

// ─── Live recording grid tile ────────────────────────────────────────
// Used by the Lives profile tab. Mirrors the Reels GridItem look (full-
// bleed 1:1 cell, hairline gutters) but layers a duration chip + view
// count overlay so the user can scan their saved replays. Long-press on
// own profile opens the delete confirm (wired in renderTabContent).
function LiveGridItem({ rec, size, onPress, onLongPress }) {
  const thumb = rec?.thumbnail_url ? resolveMedia(rec.thumbnail_url) : '';
  // Prefer viewer_count (peak live audience) over view_count when both are
  // present — the backend started returning both as of 2026-05-18 and we
  // want to settle on viewer_count as the canonical "X people watched"
  // metric for replays. Falls back across legacy keys for older clients.
  const views = Number(rec?.viewer_count || rec?.view_count || rec?.views || 0);
  const viewLabel = views >= 1000
    ? `${(views / 1000).toFixed(views >= 10000 ? 0 : 1)}K`
    : (views > 0 ? String(views) : '');
  const dur = Number(rec?.duration || 0);
  const durLabel = dur > 0
    ? (dur >= 3600
      ? `${Math.floor(dur / 3600)}:${String(Math.floor((dur % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(dur % 60)).padStart(2, '0')}`
      : `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`)
    : '';
  // Short date badge for the top-left corner — e.g. "18/05" or "12 may".
  // Helps the user scan their live history at a glance (TikTok parity).
  // We parse the raw started_at/ended_at string; if it's an ISO without TZ
  // we treat it as UTC (backend stamps it that way).
  let dateLabel = '';
  try {
    const raw = rec?.ended_at || rec?.started_at;
    if (raw) {
      const iso = String(raw).indexOf('T') >= 0 && String(raw).indexOf('Z') < 0
        ? `${raw}Z` : raw;
      const d = new Date(iso);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        dateLabel = `${day}/${month}`;
      }
    }
  } catch {}
  return (
    <TouchableOpacity onPress={onPress} onLongPress={onLongPress} activeOpacity={0.85}
      style={{ width: size, height: size, padding: 0.5 }}
      accessibilityLabel={rec?.title || 'Live replay'}
    >
      <View style={{ width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#0a0a0a' }}>
        {thumb
          ? (WEB
              ? <img src={thumb} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3 }} alt="" loading="lazy" decoding="async" />
              : (_ExpoImage
                  ? <_ExpoImage source={{ uri: thumb }} style={{ width: '100%', height: '100%', borderRadius: 3 }} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                  : <Image source={{ uri: thumb }} style={{ width: '100%', height: '100%', borderRadius: 3 }} resizeMode="cover" />))
          : <View style={{ width: '100%', height: '100%', backgroundColor: '#1a1a1a', borderRadius: 3 }} />}
        {/* Soft bottom gradient so view count + duration chip stay readable
            on top of bright thumbnails. Web uses CSS linear-gradient (no
            third-party deps); native falls back to a translucent overlay. */}
        {WEB ? (
          // eslint-disable-next-line react/forbid-dom-props
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, height: '38%',
              backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.55))',
            }}
          />
        ) : (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, height: '38%',
              backgroundColor: 'rgba(0,0,0,0.28)',
            }}
          />
        )}
        {/* Top-left: red LIVE chip + date — IG/TikTok signature so users
            instantly read the tile as "this was a live broadcast". */}
        <View style={{
          position: 'absolute', top: 6, left: 6,
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
          backgroundColor: 'rgba(0,0,0,0.55)',
        }}>
          <View style={{
            width: 6, height: 6, borderRadius: 3,
            backgroundColor: '#ef4444', marginRight: 4,
          }} />
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>
            LIVE{dateLabel ? ` · ${dateLabel}` : ''}
          </Text>
        </View>
        {/* Top-right play badge — same visual weight as the Reels grid so
            the two tabs feel consistent. */}
        <View style={{
          position: 'absolute', top: 6, right: 6,
          width: 22, height: 22, borderRadius: 11,
          backgroundColor: 'rgba(0,0,0,0.45)',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <IconPlay size={12} color="#fff" />
        </View>
        {/* Bottom-left: ▶ view count (matches Reels overlay convention). */}
        {!!viewLabel && (
          <View style={{ position: 'absolute', bottom: 6, left: 6 }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 }}>
              ▶ {viewLabel}
            </Text>
          </View>
        )}
        {/* Bottom-right: duration chip — distinguishes lives from reels
            (reels don't show duration on the grid). */}
        {!!durLabel && (
          <View style={{
            position: 'absolute', bottom: 6, right: 6,
            paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
            backgroundColor: 'rgba(0,0,0,0.55)',
          }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{durLabel}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── Animated tab bar (Posts / Reels / Mídia / …) ────────────────────
// Instagram-style sticky tabs with a sliding underline. The underline
// translates between tab slots in 200ms (cubic-out) and lives on the GPU
// thanks to `useNativeDriver`. Color of icon/text crossfades at the same
// time so the active state never feels janky.
function AnimatedTabBar({ tabs, activeKey, onChange, colors }) {
  const [barW, setBarW] = useState(0);
  const tabCount = Math.max(1, tabs.length);
  const slotW = barW / tabCount;
  const activeIdx = Math.max(0, tabs.findIndex(tb => tb.k === activeKey));
  const indicatorX = useRef(new Animated.Value(activeIdx * slotW)).current;
  // Crossfade opacity: dip to 0.4 mid-transition and snap back to 1 once
  // settled, so the underline reads as "lifting" between tabs instead of
  // sliding through. Driven by a separate Animated.Value so it can dim+
  // restore in a single sequence.
  const indicatorOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!barW) return;
    Animated.parallel([
      Animated.timing(indicatorX, {
        toValue: activeIdx * slotW,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(indicatorOpacity, { toValue: 0.4, duration: 100, useNativeDriver: true }),
        Animated.timing(indicatorOpacity, { toValue: 1, duration: 100, useNativeDriver: true }),
      ]),
    ]).start();
  }, [activeIdx, slotW, barW, indicatorX, indicatorOpacity]);
  const accent = colors?.text || '#0f172a';
  const muted = colors?.textTertiary || '#9ca3af';
  return (
    <View
      onLayout={e => setBarW(e.nativeEvent.layout.width)}
      style={{
        flexDirection: 'row',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: colors?.border,
        backgroundColor: colors?.background,
        position: 'relative',
      }}
    >
      {tabs.map(tb => {
        const active = activeKey === tb.k;
        const Icon = tb.icon;
        return (
          <TouchableOpacity
            key={tb.k}
            onPress={() => onChange(tb.k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tb.label}
            activeOpacity={0.75}
            style={{ flex: 1, paddingVertical: 11, alignItems: 'center' }}
          >
            {Icon ? (
              // Instagram parity: pure icon, no count badge — thicker stroke
              // when active so the difference reads at a glance.
              <Icon size={24} color={active ? accent : muted} />
            ) : (
              <Text style={{ fontSize: 13, color: active ? accent : muted, fontWeight: active ? '700' : '500', letterSpacing: 0.2, textTransform: 'uppercase' }}>
                {tb.label}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
      {/* Sliding underline — Instagram-grade: full-slot width, brand purple
          accent, slightly thicker (2.5px) so it reads from a glance. Lives
          on the GPU via translateX. */}
      {barW > 0 && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: -StyleSheet.hairlineWidth,
            left: 0,
            width: slotW,
            height: 2.5,
            transform: [{ translateX: indicatorX }],
            opacity: indicatorOpacity,
            backgroundColor: '#7C3AED',
            borderTopLeftRadius: 2,
            borderTopRightRadius: 2,
          }}
        />
      )}
    </View>
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
  // Instagram-grade grid: full-bleed 1:1 cells with hairline 0.5px gutters
  // (vs. the previous 1px padding which doubled to 2px between siblings and
  // made the grid feel airier than IG's tight mosaic). The play badge moves
  // top-right with a soft scrim so reels still read as motion-content even on
  // a bright thumbnail. View count surfaces bottom-left for reels (when
  // available) — matches Instagram's "1.2K" overlay on profile reels grid.
  const viewCount = (isReel || item.type === 'video' || item.media_type === 'video')
    ? (item.view_count || item.views || item.play_count || 0)
    : 0;
  const viewLabel = viewCount >= 1000
    ? `${(viewCount / 1000).toFixed(viewCount >= 10000 ? 0 : 1)}K`
    : (viewCount > 0 ? String(viewCount) : '');
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{ width: size, height: size, padding: 0.5 }}
    >
      <View style={{ width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#0a0a0a' }}>
        {renderImg()}
        {(item.type === 'video' || isReel) && (
          <>
            <View style={{
              position: 'absolute', top: 6, right: 6,
              width: 22, height: 22, borderRadius: 11,
              backgroundColor: 'rgba(0,0,0,0.35)',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <IconVideo size={13} color="#fff" />
            </View>
            {!!viewLabel && (
              <View style={{
                position: 'absolute', bottom: 6, left: 6,
                flexDirection: 'row', alignItems: 'center', gap: 4,
              }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 }}>
                  ▶ {viewLabel}
                </Text>
              </View>
            )}
          </>
        )}
      </View>
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
  // ─── Lives tab state (2026-05-18) ───
  // Saved CF Stream replays of the profile owner. Loaded lazily the first
  // time the Lives tab is focused so we don't waste a network round-trip
  // on every profile open. `livesLoaded` gates the fetch — without it the
  // tab refetched on every render.
  const [lives, setLives] = useState([]);
  const [livesLoading, setLivesLoading] = useState(false);
  const [livesLoaded, setLivesLoaded] = useState(false);
  const [storyViewer, setStoryViewer] = useState({ open: false, startIdx: 0 });
  // WAVE 95 (2026-05-21): tap-to-fullscreen profile photo lightbox for
  // OTHER users (no stories). Previously the avatar tap fired into the
  // StoryViewer with a synthetic empty list, which renders an empty story
  // (black screen, no photo). Lightbox gives users a real WhatsApp-style
  // "see the photo big" affordance.
  const [avatarLightboxOpen, setAvatarLightboxOpen] = useState(false);
  // [feat-10] Highlight viewer state — separate from storyViewer so opening a
  // highlight doesn't clobber the live-stories starting index. items[] mirrors
  // the shape StoryViewer expects (id, media_url, type, bg_color, ...).
  const [highlightViewer, setHighlightViewer] = useState({ open: false, items: [], title: '', startIdx: 0, highlightId: null });
  // [2026-05-18] Highlights moved to dedicated state so a profile_get
  // revalidation can't wipe them. Pre-fix: highlights lived inside
  // `data.highlights`, but profile_get never returns that key, so any time
  // setData(r.data) ran after an optimistic create, the new destaque
  // disappeared until the next mount (user report: "adicionei o destaque
  // e some, não deixa ver"). Independent state survives those overwrites.
  const [highlights, setHighlights] = useState([]);
  // [WAVE 52 / 2026-05-21] Loading state powers the skeleton row that paints
  // 4 shimmer circles while the first statusHighlightList resolves — IG shows
  // the strip outline immediately on profile open, never a blank gap.
  const [highlightsLoading, setHighlightsLoading] = useState(true);
  // [2026-05-18 IG-Pro] Action sheet + edit/share modals for highlights.
  // The action sheet opens on long-press of a highlight tile and routes
  // into either the inline edit sheet (rename/cover/items) or the share
  // sheet (public link / native share). State is held at this level so
  // both sheets can be toggled without re-mounting the row.
  const [highlightSheet, setHighlightSheet] = useState({ open: false, highlight: null });
  const [highlightEdit, setHighlightEdit] = useState({ open: false, highlight: null });
  const [highlightShare, setHighlightShare] = useState({ open: false, highlight: null });
  // [feat-11] Avatar tap action sheet + StatusCamera visibility. The avatar
  // is the single, most-tapped surface on the profile and was overloaded:
  //   - with stories → view stories
  //   - without stories → silently jumps into ImagePicker, publishes a status
  //     (user had no way to edit/crop/filter, no way to change avatar from same
  //     spot, no way to just "see" their own avatar)
  // The action sheet disambiguates: status creator (with filters), profile
  // photo edit, view photo full-screen, cancel.
  const [avatarActionOpen, setAvatarActionOpen] = useState(false);
  const [statusCameraOpen, setStatusCameraOpen] = useState(false);
  const [statusPublishing, setStatusPublishing] = useState(false);
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
  // 2026-05-18 — diamond gift send sheet. Opens from the chip below the
  // primary action row on non-self profiles. State only — sheet itself is
  // rendered at the bottom of the Profile tree.
  const [sendDiamondOpen, setSendDiamondOpen] = useState(false);
  // Per-user contact nickname (WhatsApp-style rename). Loaded from the
  // chat_nickname_list endpoint on mount; overrides display name locally.
  const [nicknameValue, setNicknameValue] = useState('');
  // Cross-platform nickname edit modal — Alert.prompt only works on iOS,
  // so Android needs a real modal. State here so the menu can open it.
  const [nicknameModalOpen, setNicknameModalOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  // Per-contact "hide my status from this person" toggle (WhatsApp parity).
  // Backed by chat_user_privacy_contacts (email, contact_email, field='status',
  // visibility='hide'|'show'). Optimistic UI — flips immediately on tap,
  // POST reconciles in the background.
  const [hideStatusFromContact, setHideStatusFromContact] = useState(false);
  const [hideStatusSaving, setHideStatusSaving] = useState(false);

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
        // Hard 12s timeout so skeleton can't sit forever waiting on a
        // hung fetch — reported 2026-05-12 ("skeleton infinito no /perfil").
        // Without this, an api.profileGet() that never resolves (slow CDN,
        // dead socket on cellular handoff, etc.) leaves the user staring
        // at gray placeholders until they kill the app.
        const r = await Promise.race([
          api.profileGet(fetchKey),
          new Promise((_, rej) => setTimeout(() => rej(new Error('profile_timeout')), 12000)),
        ]);
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
        // Offline / network failure: keep showing cached snapshot (no error,
        // no spinner). Without this the screen sat on a skeleton when the
        // device had no connection — reported "perfil só fica carregando".
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

  // Load per-contact "hide status from" preference. Endpoint returns the
  // full list of overrides for the current user; we scan for an entry
  // matching this contact + field='status'. Default = 'show'.
  useEffect(() => {
    if (!identity?.email) return;
    if (identity.email === currentUser?.email) return; // not applicable to self
    let cancelled = false;
    (async () => {
      try {
        const r = await api.chatPrivacyContactList?.();
        if (cancelled) return;
        const items = r?.data?.items || r?.items || [];
        const target = String(identity.email).toLowerCase();
        const match = items.find(it =>
          String(it?.contact_email || '').toLowerCase() === target &&
          String(it?.field || '') === 'status'
        );
        setHideStatusFromContact(match?.visibility === 'hide');
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [identity?.email, currentUser?.email]);

  const handleToggleHideStatus = useCallback(async (next) => {
    if (!identity?.email) return;
    if (hideStatusSaving) return;
    const desired = typeof next === 'boolean' ? next : !hideStatusFromContact;
    setHideStatusFromContact(desired); // optimistic
    setHideStatusSaving(true);
    try {
      await api.chatPrivacyContactSet?.({
        email: identity.email,
        field: 'status',
        visibility: desired ? 'hide' : 'show',
      });
    } catch {
      // Revert on failure.
      setHideStatusFromContact(!desired);
    } finally {
      setHideStatusSaving(false);
    }
  }, [identity?.email, hideStatusFromContact, hideStatusSaving]);

  // [feat-10, 2026-05-15] Story highlights — fetch persisted highlights from
  // chat_status_highlights into dedicated `highlights` state. Was previously
  // merged into `data.highlights`, but profile_get (which never returns
  // highlights) would overwrite the merge via setData(r.data), making
  // freshly-created destaques vanish — user report "add destaque, some".
  //
  // refetchHighlights is exposed so create/delete handlers can pull the
  // authoritative list right after mutating, instead of doing optimistic
  // splices that get clobbered. Wrapped in useCallback so the focus +
  // AppState effects below get a stable identity.
  const refetchHighlights = useCallback(async () => {
    if (!identity?.email) return;
    try {
      const r = await api.statusHighlightList?.(identity.email);
      const list = r?.data?.highlights || r?.highlights || [];
      if (!Array.isArray(list)) return;
      // Normalize shape — cover_url is what the row renderer expects.
      // Backend returns `active_count` (real count of still-resolvable
      // status rows). Trust active_count when present — status_ids.length
      // is a tombstone-prone fallback for old backends. Also hide
      // highlights with active_count=0 client-side as a defense in depth.
      const normalized = list.map((h) => {
        const ac = (typeof h.active_count === 'number') ? h.active_count
                  : (typeof h.count === 'number') ? h.count
                  : (Array.isArray(h.status_ids) ? h.status_ids.length : 0);
        return {
          id: h.id,
          title: h.name || h.title || '',
          cover_url: h.cover_url || '',
          status_ids: Array.isArray(h.status_ids) ? h.status_ids : [],
          count: ac,
          active_count: ac,
        };
      }).filter(h => h.active_count > 0);
      // [#1134, 2026-05-18] Merge instead of replace — preserves optimistic
      // adds whose underlying status_ids may not have propagated through
      // pgbouncer to the read side yet. Without this, a freshly created
      // highlight could disappear from local state on the very next refetch
      // call (which runs ~immediately after create), even though the row is
      // valid in PG. The next AppState-triggered refetch will reconcile.
      setHighlights(prev => {
        if (!Array.isArray(prev) || prev.length === 0) return normalized;
        const backendIds = new Set(normalized.map(h => h.id));
        const pendingOptimistic = prev.filter(h =>
          !backendIds.has(h.id)
          && Array.isArray(h.status_ids) && h.status_ids.length > 0
          // Only keep optimistic adds — anything we read from backend before
          // should have been in normalized; if it's not, the backend chose
          // to hide it (true zombie) and we respect that.
          && (typeof h._optimistic === 'boolean' ? h._optimistic : true)
        );
        return [...pendingOptimistic, ...normalized];
      });
    } catch {} finally {
      // [WAVE 52] Drop the skeleton once the first list resolves (success or
      // failure). Subsequent refetches keep the painted strip and only swap
      // data — never re-trigger the skeleton flash on AppState refocus.
      setHighlightsLoading(false);
    }
  }, [identity?.email]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refetchHighlights();
      if (cancelled) return;
    })();
    // Refetch on app foreground — covers the case where user backgrounded
    // after creating a destaque on another device, then reopened here.
    let appSub;
    try {
      appSub = AppState.addEventListener('change', (s) => {
        if (s === 'active') { refetchHighlights(); }
      });
    } catch {}
    return () => { cancelled = true; try { appSub?.remove?.(); } catch {} };
  }, [refetchHighlights]);

  // Live detection — Instagram parity. When the profile owner is currently
  // broadcasting (active row in chat_live_sessions), we paint a red AO VIVO
  // ring on the avatar and tap routes to /live-viewer instead of the story
  // viewer / picker.
  //
  // Bug fix (user report 2026-05-18): badge "AO VIVO" persistia no profile
  // mesmo após o host fechar a live. Root cause era 4-fold:
  //   1) Poll 60s → janela longa de UI stale.
  //   2) Sem `useFocusEffect` / AppState refetch — abrir o próprio profile
  //      depois de encerrar a broadcast não disparava nova consulta.
  //   3) Sem hook local pra `endBroadcast()` — host dependia 100% do WS
  //      `live_ended` chegar de volta a si próprio; em race de subscribe ou
  //      perda momentânea de WS, o evento sumia (sem replay).
  //   4) WS event handler é OK, mas se a subscribe acontece DEPOIS do server
  //      ter despachado o `live_ended`, o cliente nunca vê.
  // Fix: encurta poll pra 20s, refetch ao voltar app pro foreground, e
  // escuta `profile:live_ended` (DeviceEventEmitter) emitido pelo
  // live-broadcast.js no momento exato do endBroadcast — zero round-trip.
  //
  // [Bug #1133, 2026-05-18 — REGRESSION] AO VIVO still sticking even with
  // all the listeners wired up. Root cause is a stale-response race:
  //   T=0  tick() fires → live_list HTTP request leaves
  //   T=2  user ends the broadcast → performEndLive emits DeviceEvent
  //        AND backend live_end{,_cf} broadcasts live_ended on lives_global
  //        → both listeners clear setLiveSessionId(null)
  //   T=3  the T=0 in-flight tick() response finally lands carrying the
  //        still-live session (snapshot taken before live_end committed)
  //        → setLiveSessionId('xxx') RE-STICKS the badge
  // Belt-and-suspenders: track the moment we saw an end signal in
  // `liveEndedAtRef`. Any tick() response that landed AFTER an end is
  // ignored for 30s (covers backend write→read lag + WS broadcast race).
  // Also drop duplicate setState when value unchanged so no re-render
  // storms during the close/reopen flicker.
  const [liveSessionId, setLiveSessionId] = useState(null);
  const liveEndedAtRef = useRef(0);
  const liveTickStartedAtRef = useRef(0);
  useEffect(() => {
    if (!identity?.email) { setLiveSessionId(null); return undefined; }
    let cancelled = false;
    const target = identity.email.toLowerCase();
    const tick = async () => {
      const startedAt = Date.now();
      liveTickStartedAtRef.current = startedAt;
      try {
        const r = await api.apiCall?.('live_list', null, 'POST');
        if (cancelled) return;
        // Stale-response guard — if an end signal fired AFTER this tick
        // started, the response is taking a DB snapshot from before the
        // end committed. Trust the end signal and drop the response.
        if (liveEndedAtRef.current >= startedAt) return;
        const lives = r?.data?.lives || r?.lives || [];
        const found = lives.find(l => (l?.host_email || '').toLowerCase() === target);
        // [WAVE 37 2026-05-20] User report: "ainda mostra ao vivo agora mas a live
        // nem comecou". Root cause is a ghost chat_live_sessions row stuck in
        // status='live' (failed start, crash mid-broadcast, backend's 5min/6h
        // auto-end heuristic running late). The backend probe shows live_list
        // includes started_at, so guard client-side: any session older than 6h
        // is treated as ghost regardless of status. This matches the backend's
        // auto-end ceiling and gives the user instant correctness if the cron
        // is lagging or the auto-end query missed.
        let nextId = found?.id || null;
        if (found && found.started_at) {
          try {
            const startedMs = new Date(found.started_at).getTime();
            if (Number.isFinite(startedMs)) {
              const ageH = (Date.now() - startedMs) / 3600000;
              if (ageH > 6) {
                console.warn('[Profile.live] ignoring ghost session age=' + ageH.toFixed(1) + 'h id=' + found.id);
                nextId = null;
              }
            }
          } catch {}
        }
        setLiveSessionId(prev => (prev === nextId ? prev : nextId));
      } catch {
        if (!cancelled) setLiveSessionId(prev => (prev === null ? prev : null));
      }
    };
    const markEnded = () => {
      liveEndedAtRef.current = Date.now();
      setLiveSessionId(prev => (prev === null ? prev : null));
    };
    tick();
    const iv = setInterval(tick, 20000);
    // WS instant updates — when this profile's owner goes live or ends a
    // live, flip the badge state without waiting for the 20s poll.
    let unsubOn, unsubOff;
    try {
      const mailWs = require('../services/websocket').default;
      mailWs.subscribe?.('lives_global');
      unsubOn = mailWs.on?.('live_started', (payload) => {
        const d = payload?.data || payload || {};
        if ((d.host_email || '').toLowerCase() === target) {
          // Don't paint AO VIVO from a stale live_started echo that arrives
          // AFTER an end signal (server can replay a buffered event during
          // reconnect). 30s grace mirrors the stale-tick guard above.
          if (Date.now() - liveEndedAtRef.current < 30000) return;
          // [WAVE 37] Reject stale started events for sessions whose started_at
          // is already too old to be a real "just started" event (>6h matches
          // backend's auto-end ceiling). Without this, a WS replay during
          // reconnect could re-paint AO VIVO on a long-dead session id.
          if (d.started_at) {
            try {
              const startedMs = new Date(d.started_at).getTime();
              if (Number.isFinite(startedMs) && (Date.now() - startedMs) > 6 * 3600 * 1000) {
                console.warn('[Profile.live] ignoring stale live_started echo, age>6h');
                return;
              }
            } catch {}
          }
          // [WAVE 38 2026-05-20] Always overwrite — host re-broadcast scenario
          // (live #1 ended, live #2 started seconds later) must paint the
          // NEW session_id even if a stale value happened to still be in
          // local state. Setter is idempotent if values match.
          setLiveSessionId(d.session_id || null);
        }
      });
      unsubOff = mailWs.on?.('live_ended', (payload) => {
        const d = payload?.data || payload || {};
        if ((d.host_email || '').toLowerCase() === target) markEnded();
      });
    } catch {}
    // Local fast-path — the host's own endBroadcast() emits this so the
    // badge on his own profile clears INSTANTLY without waiting for the
    // WS round-trip (which can race the subscribe or be dropped if WS
    // disconnected mid-stream). We require host_email match so we never
    // accidentally clear the badge on a *different* user's profile that
    // happens to be mounted (peek over a chat with the broadcaster, e.g.).
    let localSub;
    try {
      localSub = DeviceEventEmitter.addListener('profile:live_ended', (d) => {
        const he = (d?.host_email || '').toLowerCase();
        if (he && he === target) markEnded();
      });
    } catch {}
    // Foreground refetch — covers the case where the host backgrounded the
    // app, ended the live from a different surface (e.g. native CallKit
    // dismissed), then reopened the profile.
    let appSub;
    try {
      appSub = AppState.addEventListener('change', (s) => {
        if (s === 'active') tick();
      });
    } catch {}
    return () => {
      cancelled = true;
      clearInterval(iv);
      try { unsubOn?.(); } catch {}
      try { unsubOff?.(); } catch {}
      try { localSub?.remove?.(); } catch {}
      try { appSub?.remove?.(); } catch {}
    };
  }, [identity?.email]);

  // "Contatos em comum" — fetched separately because not every profileGet
  // payload includes it (older backend builds). If the endpoint isn't
  // deployed yet, api.commonContacts swallows the error and returns [].
  // We hide the section unless there's at least one match OR the viewer
  // is non-self (then we show the "Em breve" placeholder for parity).
  const [commonContactsData, setCommonContactsData] = useState([]);
  useEffect(() => {
    if (!identity?.email) { setCommonContactsData([]); return undefined; }
    if (identity.email === currentUser?.email) { setCommonContactsData([]); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.commonContacts(identity.email);
        if (cancelled) return;
        const items = Array.isArray(r?.items) ? r.items : [];
        setCommonContactsData(items);
      } catch {
        if (!cancelled) setCommonContactsData([]);
      }
    })();
    return () => { cancelled = true; };
  }, [identity?.email, currentUser?.email]);

  const presence = data?.presence;
  const social = data?.social;
  const actions = data?.actions || {};
  const selfOnly = data?.self_only;
  const posts = data?.posts || [];
  const reels = data?.reels || [];
  // Lazy-load the saved-lives list when the Lives tab is focused for
  // the first time. Subsequent tab switches reuse the cached array;
  // pull-to-refresh on the profile root would reset livesLoaded.
  useEffect(() => {
    if (activeTab !== 'lives') return;
    if (livesLoaded || livesLoading) return;
    const targetEmail = identity?.email;
    if (!targetEmail) return;
    let cancelled = false;
    setLivesLoading(true);
    (async () => {
      try {
        const res = await api.liveRecordingsList({ user_email: targetEmail });
        if (cancelled) return;
        const list = Array.isArray(res?.data?.recordings) ? res.data.recordings : [];
        setLives(list);
        setLivesLoaded(true);
      } catch {
        if (!cancelled) {
          setLives([]);
          setLivesLoaded(true);
        }
      } finally {
        if (!cancelled) setLivesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, livesLoaded, livesLoading, identity?.email]);
  const sharedMedia = data?.shared_media || [];
  // Backend returns BOTH direct + group conversations where me+target are members.
  // The "Grupos em comum" section is specifically for groups — a direct DM with
  // the same person you're viewing is meaningless to list (its display "name"
  // falls back to the target's email, which leaked as e.g. "sara.costa@chatyy.com.br"
  // showing up under GROUPS IN COMMON). Filter to type==='group' only.
  const commonChats = (data?.common_chats || []).filter(c => c?.type === 'group');
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
        // Pass only `url` (not both message+url) — iOS Share Extension splits
        // into two NSItemProvider attachments (url + text), causing the
        // recipient app to receive the same payload twice (compose body
        // duplicado x2 reported on 2026-05-08).
        Share?.share({ url });
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

  // ─── Story Highlights row (Instagram parity) ────────────────────────
  // Horizontal-scroll row of circular highlight covers (72px ring — IG's
  // current spec lands between 70–77 depending on screen width; 72 keeps
  // the row balanced on 360dp Androids while feeling proper on 414dp iOS).
  // When the viewer is `is_self` and there are zero highlights, show a
  // "Novo" tile with a + icon as the first slot — Instagram pattern that
  // nudges users to start curating.
  // [WAVE 52] Skeleton row paints 4 shimmer placeholders during the first
  // refetch so the strip never collapses to a blank gap; stagger fade-in
  // makes the real tiles slide up after data arrives.
  const renderHighlights = () => {
    const isSelf = !!actions?.is_self;
    const SIZE = 72;
    const RING = SIZE + 6; // 3px ring on each side
    const tone = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)';
    const borderTone = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)';
    // Skeleton while waiting for first list. Mirrors strip dimensions so
    // there's zero layout shift when data resolves.
    if (highlightsLoading && highlights.length === 0) {
      return (
        <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 6, gap: 16 }}>
          {[0,1,2,3].map(i => (
            <View key={i} style={{ alignItems: 'center', width: SIZE + 8 }}>
              <View style={{
                width: RING, height: RING, borderRadius: RING / 2,
                backgroundColor: tone,
                borderWidth: 1.5, borderColor: borderTone,
              }} />
              <View style={{
                width: SIZE - 18, height: 9, borderRadius: 4,
                backgroundColor: tone, marginTop: 8,
              }} />
            </View>
          ))}
        </View>
      );
    }
    if (highlights.length === 0 && !isSelf) return null;
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 6, gap: 16 }}
      >
        {isSelf && (
          <TouchableOpacity
            activeOpacity={0.8}
            style={{ alignItems: 'center', width: SIZE + 8 }}
            onPress={async () => {
              // Instagram-style highlight composer: pick photos → name → upload as
              // statuses → bundle into highlight. Pre-2026-05-09 só criava um
              // destaque vazio que o user achava bugado ("nada acontece").
              try {
                const ImagePicker = require('expo-image-picker');
                // Permissão necessária pra abrir a galeria. Em web/iOS já dispara
                // o prompt nativo; Android precisa do request explícito.
                const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                if (perm.status !== 'granted') {
                  Alert.alert(
                    t?.('common.permission') || 'Permissão necessária',
                    t?.('profile.highlightNeedPhotos') || 'Pra criar um destaque, libere acesso às fotos.'
                  );
                  return;
                }
                const pick = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ImagePicker.MediaTypeOptions.Images,
                  allowsMultipleSelection: true,
                  // Instagram caps highlights at ~100 items. Backend already
                  // accepts up to 100 ids per highlight (see
                  // status_highlight_create slice(0,100)); bumped picker cap
                  // from 10 → 50 so curators can build large destaques in a
                  // single round-trip without the "Adicionar +" loop. 50 (not
                  // 100) keeps memory/upload pressure reasonable on mid-tier
                  // Android — users can chain a second pick for the rest.
                  selectionLimit: 50,
                  quality: 0.85,
                });
                if (pick.canceled) return;
                const assets = Array.isArray(pick.assets) ? pick.assets : [];
                if (!assets.length) return;

                // Coleta nome em prompt nativo (depois das fotos, igual Instagram)
                const askName = () => new Promise((resolve) => {
                  if (Platform.OS === 'ios') {
                    try {
                      Alert.prompt(
                        t?.('profile.newHighlight') || 'Novo destaque',
                        t?.('profile.newHighlightHint') || 'Dê um nome (ex: Viagens, Praia).',
                        [
                          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(null) },
                          { text: t?.('common.create') || 'Criar', onPress: (n) => resolve(String(n || '').trim() || 'Destaque') },
                        ],
                        'plain-text', ''
                      );
                    } catch { resolve('Destaque'); }
                  } else if (Platform.OS === 'web' && typeof window !== 'undefined' && window.prompt) {
                    const v = window.prompt(t?.('profile.newHighlightHint') || 'Nome do destaque:', '');
                    resolve(v === null ? null : (v.trim() || 'Destaque'));
                  } else {
                    // Android sem Alert.prompt — usa nome default. User pode
                    // editar depois quando o backend de rename ficar pronto.
                    resolve(t?.('profile.highlightDefaultName') || 'Destaque');
                  }
                });
                const name = await askName();
                if (!name) return;

                // Upload + status_create por foto. Mostra busy via Alert
                // simples (mais robusto que um modal full-screen aqui).
                const statusIds = [];
                let coverUrl = '';
                // [#1134] Capture the last upload/publish error so we can
                // surface it instead of the generic "Não consegui enviar"
                // when nothing succeeds. Was masking real failures
                // (e.g. statusPublish returning success without an id, or a
                // 401/quota error) → user just saw "tente de novo" forever.
                let lastErr = '';
                for (let i = 0; i < assets.length; i++) {
                  const a = assets[i];
                  if (!a?.uri) continue;
                  try {
                    const fileLike = {
                      uri: a.uri,
                      name: a.fileName || `hl_${Date.now()}_${i}.jpg`,
                      type: a.mimeType || 'image/jpeg',
                    };
                    const up = await api.statusUpload(fileLike);
                    // Prefer the CDN URL so the destaque cover paints from
                    // Cloudflare edge instead of US origin. status_upload now
                    // returns both `cdn_url` (absolute media.chatyy.com.br)
                    // and `url` (legacy relative /data/status/*).
                    const url = up?.data?.cdn_url || up?.data?.url || up?.url || '';
                    if (!url) {
                      lastErr = up?.message || up?.data?.message || 'upload_no_url';
                      continue;
                    }
                    if (!coverUrl) coverUrl = url;
                    const pub = await api.statusPublish(url, 'image', '#7C3AED');
                    const sid = pub?.id || pub?.data?.id || pub?.status_id;
                    if (sid) {
                      statusIds.push(sid);
                    } else {
                      lastErr = pub?.message || pub?.data?.message || 'publish_no_id';
                    }
                  } catch (e) { lastErr = e?.message || 'exception'; }
                }
                if (statusIds.length === 0) {
                  // Surface the actual failure mode in dev/test builds.
                  // Production users still see the friendly fallback.
                  try { console.warn('[highlight.create] all photos failed:', lastErr); } catch {}
                  Alert.alert(t?.('common.error') || 'Erro', t?.('profile.highlightUploadFail') || 'Não consegui enviar as fotos. Tente de novo.');
                  return;
                }
                const r = await api.statusHighlightCreate(name, statusIds, coverUrl);
                if (r?.success) {
                  const newId = r.id || r.data?.id;
                  // Optimistic add so the tile appears instantly...
                  if (newId) {
                    const newH = {
                      id: newId,
                      title: name,
                      cover_url: coverUrl,
                      status_ids: statusIds,
                      count: statusIds.length,
                      active_count: statusIds.length,
                      // [#1134] Flag so refetchHighlights preserves this row
                      // across the immediate reconciliation pass (pgbouncer
                      // read lag could miss it). Next AppState refresh will
                      // converge to the backend's truth.
                      _optimistic: true,
                    };
                    setHighlights(prev => {
                      // Dedup just in case refetchHighlights raced ahead.
                      if (prev.some(h => h.id === newId)) return prev;
                      return [newH, ...prev];
                    });
                  }
                  // ...then reconcile against the backend (covers cover_url
                  // normalization, race with cache, etc.). Was the missing
                  // piece — without this the optimistic add would survive
                  // but the *next* profile_get revalidation (pre-2026-05-18
                  // shared state) wiped it.
                  refetchHighlights();
                } else {
                  // Backend rejected the create (e.g. 400 "No statuses to
                  // highlight"). Surface the real reason so the user
                  // understands what went wrong. Pre-#1134 the backend
                  // silently inserted an empty zombie on create-with-no-ids
                  // and the user got success → invisible row → "doesn't
                  // work". Now we get a 400 with a clear message.
                  const msg = r?.message || r?.data?.message || (t?.('profile.highlightUploadFail') || 'Não consegui criar o destaque.');
                  Alert.alert(t?.('common.error') || 'Erro', msg);
                }
              } catch (e) {
                Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falhou');
              }
            }}
          >
            <View style={{
              width: RING, height: RING, borderRadius: RING / 2,
              borderWidth: 1.5, borderColor: borderTone,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: tone,
            }}>
              <IconPlus size={30} color={colors?.text} strokeWidth={2} />
            </View>
            <Text style={{ fontSize: 12, color: colors?.text, marginTop: 6, fontWeight: '500', letterSpacing: 0.1 }} numberOfLines={1}>
              {t?.('profile.newHighlight') || 'Novo'}
            </Text>
          </TouchableOpacity>
        )}
        {highlights.map(h => {
          const cover = h.cover_url ? resolveMedia(h.cover_url) : null;
          // Instagram gradient ring (purple → fuchsia → orange) so destaques
          // stand out from regular avatars. Painted via SVG when available;
          // gracefully falls back to a solid purple ring in degraded envs so
          // we never lose the visual identity. Same palette family as the
          // profile header halo for brand consistency.
          const ringRadius = (RING / 2) - 1.5;
          const renderHighlightRing = () => {
            if (_Svg && _SvgDefs && _SvgLinearGradient && _SvgStop && _SvgCircle) {
              return (
                <_Svg width={RING} height={RING} style={{ position: 'absolute', top: 0, left: 0 }}>
                  <_SvgDefs>
                    <_SvgLinearGradient id={`hlRing_${h.id}`} x1="0" y1="0" x2="1" y2="1">
                      <_SvgStop offset="0" stopColor="#7C3AED" />
                      <_SvgStop offset="0.5" stopColor="#EC4899" />
                      <_SvgStop offset="1" stopColor="#F97316" />
                    </_SvgLinearGradient>
                  </_SvgDefs>
                  <_SvgCircle
                    cx={RING / 2}
                    cy={RING / 2}
                    r={ringRadius}
                    stroke={`url(#hlRing_${h.id})`}
                    strokeWidth={2}
                    fill="none"
                  />
                </_Svg>
              );
            }
            return null;
          };
          // [feat-10] Tap → resolve items via status_highlight_items + open
          // the existing StoryViewer. Long-press (self) → delete with
          // confirmation. Mirrors Instagram's interaction grammar.
          const openHighlight = async () => {
            try {
              const r = await api.statusHighlightItems?.(h.id);
              const items = r?.data?.items || r?.items || [];
              if (!Array.isArray(items) || items.length === 0) {
                // [2026-05-18] Destaque vazio. Two outcomes:
                //  - Owner: offer to delete the destaque (it's a dead bookmark).
                //    Also auto-prune from local state so the user doesn't keep
                //    tapping a phantom tile.
                //  - Viewer: silent dismiss — no value in shouting "vazio" at them.
                if (isSelf) {
                  Alert.alert(
                    t?.('profile.highlightEmpty') || 'Destaque vazio',
                    t?.('profile.highlightEmptyHint') || 'Esse destaque ficou sem stories. Quer apagar?',
                    [
                      { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                      {
                        text: t?.('common.delete') || 'Apagar',
                        style: 'destructive',
                        onPress: async () => {
                          try { await api.statusHighlightDelete?.(h.id); } catch {}
                          setHighlights(prev => prev.filter(x => x.id !== h.id));
                        },
                      },
                    ]
                  );
                } else {
                  // Hide it from the viewer's local state too — keeps the row tidy.
                  setHighlights(prev => prev.filter(x => x.id !== h.id));
                }
                return;
              }
              setHighlightViewer({ open: true, items, title: h.title || '', startIdx: 0, highlightId: h.id });
            } catch (e) {
              Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falhou');
            }
          };
          // [2026-05-18 IG-Pro] Long-press → action sheet (Edit / Share /
          // Delete). Replaces the previous "delete-only" prompt which gave
          // users no way to rename, swap cover, or generate a public link.
          // For viewers (non-owners) we still surface Share so they can
          // forward the highlight via the public /h/<id> link.
          // [WAVE 52] Haptic feedback on long-press mirrors IG's action-sheet
          // tactile — `Medium` impact is the same level IG uses for story-
          // tile menus. Lazy-required so a missing peer dep doesn't crash.
          const openActionSheet = () => {
            try {
              const H = require('expo-haptics');
              H.impactAsync?.(H.ImpactFeedbackStyle?.Medium);
            } catch {}
            setHighlightSheet({ open: true, highlight: { id: h.id, title: h.title, cover_url: h.cover_url, isSelf } });
          };
          return (
            <TouchableOpacity
              key={h.id}
              activeOpacity={0.85}
              style={{ alignItems: 'center', width: SIZE + 8 }}
              onPress={openHighlight}
              onLongPress={openActionSheet}
              delayLongPress={350}
              accessibilityLabel={(t?.('profile.openHighlight') || 'Abrir destaque') + ' ' + (h.title || '')}
            >
              <View style={{
                width: RING, height: RING, borderRadius: RING / 2,
                alignItems: 'center', justifyContent: 'center',
                padding: 2,
                // Solid fallback ring sits under the SVG. When the SVG paints
                // it covers this border; if SVG isn't available the user still
                // sees a purple ring (no silent visual regression).
                borderWidth: _Svg ? 0 : 2,
                borderColor: '#7C3AED',
                backgroundColor: tone,
              }}>
                {renderHighlightRing()}
                {cover ? (
                  WEB
                    ? <img src={cover} alt="" style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2, objectFit: 'cover' }} />
                    : (_ExpoImage
                        ? <_ExpoImage source={{ uri: cover }} style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2 }} contentFit="cover" cachePolicy="memory-disk" />
                        : <Image source={{ uri: cover }} style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2 }} resizeMode="cover" />)
                ) : (
                  <View style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2, backgroundColor: '#7C3AED22' }} />
                )}
              </View>
              <Text style={{ fontSize: 12, color: colors?.text, marginTop: 6, fontWeight: '500', maxWidth: SIZE + 8, letterSpacing: 0.1 }} numberOfLines={1}>
                {h.title || ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    );
  };

  const renderHeader = () => {
    if (!identity) return null;
    const postsTotal = (posts.length || 0) + (reels.length || 0);
    const coverUrl = identity.cover_url || '';
    const accountType = identity.account_type || 'personal';
    return (
      <View>
        {/* Cover photo banner — full-width 3:1 strip, sits above the avatar
            Instagram-style (no overlap; the avatar lands below in normal
            header flow). Hidden when the user hasn't set one yet to avoid
            an empty grey rectangle. Profile-upgrade combo (2026-05-18). */}
        {coverUrl ? (
          <View style={{ width: '100%', height: 150, backgroundColor: 'rgba(124,58,237,0.06)' }}>
            {_ExpoImage ? (
              <_ExpoImage source={{ uri: coverUrl }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" />
            ) : (
              <Image source={{ uri: coverUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            )}
          </View>
        ) : null}
      <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, gap: 14 }}>
        {/* Row 1 — @username + settings/menu (right aligned).
            headerLeadingSpace reserves room for the back arrow overlay in `full` mode so the
            @username doesn't get clipped behind it. Only row 1 gets the offset — posts/reels
            grid stays edge-to-edge so cells don't overflow off-screen on mobile widths. */}
        {/* Instagram top bar: @handle (24/700) on left, badge if verified,
            then on the right: discover-people (+) for self / chevron + kebab
            for others. Matches Instagram's hierarchy where username reads as
            the page title. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: headerLeadingSpace }}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: colors?.text, letterSpacing: -0.4, flexShrink: 1 }} numberOfLines={1}>
              {identity.username ? `@${identity.username}` : identity.name}
            </Text>
            {identity.verified && (
              <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#1DA1F2', alignItems: 'center', justifyContent: 'center' }}>
                <IconCheck size={12} color="#fff" strokeWidth={3} />
              </View>
            )}
            {/* Lock icon for private accounts — Instagram parity */}
            {identity.is_private && (
              <IconLock size={16} color={colors?.text} />
            )}
            {/* Account type badge — Creator (purple palette icon) / Business
                (blue briefcase icon). Personal renders nothing so most users
                see a clean header. The single-character emoji-like glyph
                comes from the user's spec; using a textual badge keeps it
                cheap (no extra SVG asset) and lets it inherit font scaling. */}
            {accountType === 'creator' && (
              <View style={{
                paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10,
                backgroundColor: 'rgba(147,51,234,0.14)',
                flexDirection: 'row', alignItems: 'center', gap: 3,
              }} accessibilityLabel={t?.('profile.accountTypeCreator') || 'Criador'}>
                <Text style={{ fontSize: 11 }}>🎨</Text>
                <Text style={{ fontSize: 11, color: '#9333EA', fontWeight: '700' }}>
                  {t?.('profile.accountTypeCreator') || 'Criador'}
                </Text>
              </View>
            )}
            {accountType === 'business' && (
              <View style={{
                paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10,
                backgroundColor: 'rgba(37,99,235,0.14)',
                flexDirection: 'row', alignItems: 'center', gap: 3,
              }} accessibilityLabel={t?.('profile.accountTypeBusiness') || 'Negócio'}>
                <Text style={{ fontSize: 11 }}>💼</Text>
                <Text style={{ fontSize: 11, color: '#2563EB', fontWeight: '700' }}>
                  {t?.('profile.accountTypeBusiness') || 'Negócio'}
                </Text>
              </View>
            )}
          </View>
          {actions.is_self ? (
            // Self profile: only kebab (settings/options). The discover-people
            // (+) button used to live here too, but it was redundant — you can
            // already open chat-new from the dedicated tab/FAB, and "follow
            // yourself" reads as a bug to users. Removed 2026-05-08.
            <TouchableOpacity onPress={() => (onOpenSettings ? onOpenSettings() : setSettingsOpen(true))} style={{ padding: 6 }} accessibilityLabel={t?.('settings.title') || 'Configurações'}>
              <IconMoreHorizontal size={24} color={colors?.text} />
            </TouchableOpacity>
          ) : (
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
            //
            // When there are no stories we still want an Instagram-grade
            // gradient halo on the header avatar (purple → fuchsia → pink).
            // Painted via SVG when `react-native-svg` is installed; falls
            // back to a 3px solid-purple ring otherwise so we never lose the
            // visual identity in degraded environments.
            const AVATAR_SIZE = 86;
            const HALO_PAD = 5; // 3px stroke + 2px inner gap
            const HALO_SIZE = AVATAR_SIZE + HALO_PAD * 2;
            const haloRadius = (HALO_SIZE / 2) - 1.5; // 3 / 2
            const renderHalo = () => {
              if (_Svg && _SvgDefs && _SvgLinearGradient && _SvgStop && _SvgCircle) {
                return (
                  <_Svg width={HALO_SIZE} height={HALO_SIZE} style={{ position: 'absolute', top: 0, left: 0 }}>
                    <_SvgDefs>
                      <_SvgLinearGradient id="profileAvatarHalo" x1="0" y1="0" x2="1" y2="1">
                        <_SvgStop offset="0" stopColor="#5B21B6" />
                        <_SvgStop offset="0.55" stopColor="#7C3AED" />
                        <_SvgStop offset="1" stopColor="#EC4899" />
                      </_SvgLinearGradient>
                    </_SvgDefs>
                    <_SvgCircle
                      cx={HALO_SIZE / 2}
                      cy={HALO_SIZE / 2}
                      r={haloRadius}
                      stroke="url(#profileAvatarHalo)"
                      strokeWidth={3}
                      fill="none"
                    />
                  </_Svg>
                );
              }
              return (
                <View style={{
                  position: 'absolute', top: 0, left: 0,
                  width: HALO_SIZE, height: HALO_SIZE, borderRadius: HALO_SIZE / 2,
                  borderWidth: 3, borderColor: '#7C3AED',
                }} />
              );
            };
            const isLive = !!liveSessionId;
            const liveLabel = (t?.('live.aoVivo') || 'AO VIVO').toUpperCase();
            const inner = hasStories ? (
              <StoryRingAvatar
                name={identity.name}
                email={identity.email}
                size={AVATAR_SIZE}
                ringStyle="solid"
                isDark={isDark}
                colors={colors}
                isLive={isLive}
                liveLabel={liveLabel}
              />
            ) : (
              <View style={{
                width: HALO_SIZE, height: HALO_SIZE,
                alignItems: 'center', justifyContent: 'center',
              }}>
                {!isLive && renderHalo()}
                <StoryRingAvatar
                  name={identity.name}
                  email={identity.email}
                  size={AVATAR_SIZE}
                  ringStyle="none"
                  isDark={isDark}
                  colors={colors}
                  isLive={isLive}
                  liveLabel={liveLabel}
                />
              </View>
            );
            // Live overrides every other tap intent — viewing a friend's live
            // is the highest-priority action. Routes to /live-viewer with the
            // session id so the WebRTC viewer hooks up immediately.
            //
            // Self-live exception: tapping your OWN live badge routes to
            // /live-broadcast (the host panel) instead of /live-viewer, since
            // the viewer can't watch its own outgoing stream and would just
            // see "Stream indisponível".
            if (isLive) {
              const selfTap = !!actions?.is_self;
              return (
                <TouchableOpacity
                  onPress={() => {
                    try {
                      if (selfTap) {
                        router?.push?.(`/live-broadcast?sessionId=${encodeURIComponent(liveSessionId)}`);
                      } else {
                        router?.push?.(`/live-viewer?sessionId=${encodeURIComponent(liveSessionId)}&hostEmail=${encodeURIComponent(identity.email)}&hostName=${encodeURIComponent(identity.name || (identity.email || '').split('@')[0])}`);
                      }
                    } catch {}
                  }}
                  activeOpacity={0.85}
                  accessibilityLabel={selfTap ? (t?.('live.backToBroadcast') || 'Voltar ao seu broadcast') : (t?.('live.watching') || 'Assistir live')}
                >{inner}</TouchableOpacity>
              );
            }
            // [feat-11, 2026-05-15] Avatar tap behaviour:
            //   Self, no stories          → open action sheet (status creator /
            //                                edit avatar / view avatar)
            //   Self, has stories         → tap views stories; long-press opens
            //                                the same action sheet (the "+" badge
            //                                is hidden behind the ring so we still
            //                                need a way to publish a new story)
            //   Other user, has stories   → tap views their stories
            //   Other user, no stories    → tap shows the photo viewer (was a
            //                                no-op before; users expected to see
            //                                the photo full-size at least)
            // Previous behaviour silently jumped into ImagePicker and published
            // without preview/crop/filter — user complaint resolved here.
            if (!hasStories) {
              if (actions?.is_self) {
                return (
                  <TouchableOpacity
                    onPress={() => setAvatarActionOpen(true)}
                    activeOpacity={0.85}
                    accessibilityLabel={t?.('profile.avatarActions') || 'Opções da foto'}
                  >{inner}</TouchableOpacity>
                );
              }
              // Other user, no stories → open the AvatarLightbox (WAVE 95).
              // Was: setStoryViewer({ open: true, startIdx: 0 }) which fed an
              // empty list into StoryViewer (black screen). Lightbox shows
              // the actual profile photo big, pinch-zoom, tap-out to close.
              return (
                <TouchableOpacity
                  onPress={() => {
                    const url = identity?.avatar_url || (identity?.email ? api.getAvatarUrlForEmail?.(identity.email) : '');
                    if (!url) return;
                    setAvatarLightboxOpen(true);
                  }}
                  activeOpacity={0.85}
                  accessibilityLabel={t?.('profile.viewPhoto') || 'Ver foto'}
                >{inner}</TouchableOpacity>
              );
            }
            return (
              <TouchableOpacity
                onPress={() => setStoryViewer({ open: true, startIdx: 0 })}
                onLongPress={actions?.is_self ? () => setAvatarActionOpen(true) : undefined}
                delayLongPress={350}
                activeOpacity={0.85}
                accessibilityLabel={t?.('profile.viewStories') || 'Ver status'}
              >{inner}</TouchableOpacity>
            );
          })()}
          {/* Instagram pattern: 3-column stats row to the right of the avatar.
              Uses justifyContent: space-around with each Stat as flex:1 column
              so numbers/labels stay vertically centered with the avatar. */}
          <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 4 }}>
            <Stat value={postsTotal} label={t?.('profile.posts') || 'Publicações'} colors={colors} />
            <Stat value={social?.followers_count || 0} label={t?.('profile.followers') || 'Seguidores'} colors={colors}
              onPress={() => (onOpenFollowers ? onOpenFollowers(identity.email, 'followers') : setFollowersTab('followers'))} />
            <Stat value={social?.following_count || 0} label={t?.('profile.following') || 'Seguindo'} colors={colors}
              onPress={() => (onOpenFollowers ? onOpenFollowers(identity.email, 'following') : setFollowersTab('following'))} />
          </View>
        </View>

        {/* Row 3 — name + bio + link + presence.
            Bio uses lineHeight 1.5 + textSecondary to match Instagram's
            comfortable read rhythm; clamped to ~520 to keep paragraphs from
            stretching to tablet widths where the eye loses the line break. */}
        <View style={{ gap: 3 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors?.text, letterSpacing: -0.1 }} numberOfLines={1}>
            {identity.name}
          </Text>
          {!!presenceText && (
            <Text style={{ fontSize: 12, color: presence?.online ? '#22c55e' : colors?.textTertiary }}>
              {presenceText}
            </Text>
          )}
          {!!identity.bio && (
            <Text style={{
              fontSize: 14,
              color: colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.65)'),
              lineHeight: 21, // ~1.5 of 14
              marginTop: 4,
              maxWidth: (SCREEN_W || 0) >= 520 ? 520 : '90%',
            }}>
              {identity.bio}
            </Text>
          )}
          {!!identity.website && (
            <Text style={{ fontSize: 13, color: '#7C3AED', fontWeight: '600', marginTop: 4 }} numberOfLines={1}>
              {identity.website}
            </Text>
          )}
          {/* Multi-link chips — up to 5 link-in-bio pills rendered as a
              flex-wrap row below the bio. Each chip opens its URL in the
              system browser (web → window.open, native → Linking). Label
              falls back to the URL host when the user didn't set one so
              empty pills don't render as `https://...` walls of text. */}
          {Array.isArray(identity.links) && identity.links.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {identity.links.slice(0, 5).map((lk, idx) => {
                const url = lk?.url || '';
                if (!url) return null;
                let host = '';
                try { host = new URL(url).host.replace(/^www\./, ''); } catch {}
                const label = (lk?.label && lk.label.trim()) || host || url;
                const open = () => {
                  try {
                    if (Platform.OS === 'web' && typeof window !== 'undefined') {
                      window.open(url, '_blank', 'noopener,noreferrer');
                    } else {
                      Linking?.openURL?.(url);
                    }
                  } catch {}
                };
                return (
                  <TouchableOpacity
                    key={`link-${idx}`}
                    onPress={open}
                    activeOpacity={0.75}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 12, paddingVertical: 7,
                      borderRadius: 16,
                      backgroundColor: isDark ? 'rgba(124,58,237,0.14)' : 'rgba(124,58,237,0.10)',
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: 'rgba(124,58,237,0.30)',
                    }}
                    accessibilityRole="link"
                    accessibilityLabel={label}
                  >
                    <IconLink size={13} color="#7C3AED" />
                    <Text
                      numberOfLines={1}
                      style={{ fontSize: 13, color: '#7C3AED', fontWeight: '600', maxWidth: 180 }}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
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
        {/* 2026-05-18 — "Enviar diamante" chip on non-self profiles.
            Opens SendDiamondSheet anchored to this user. The chip is its
            own row (full-width) so it pops visually — diamond gifts are
            the primary monetization surface. SVG icon (no emojis in UI). */}
        {!actions.is_self && identity?.email ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            <TouchableOpacity
              onPress={() => setSendDiamondOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t?.('walletSend.openCta') || 'Enviar diamante'}
              style={{
                flex: 1,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                backgroundColor: '#A855F7',
              }}
            >
              <IconGiftBox size={18} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>
                {t?.('walletSend.openCta') || 'Enviar diamante'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {actions.is_self && (
          // Self action row: Editar perfil + Compartilhar perfil. The square
          // "+" discover-people tile that used to sit on the right was
          // removed 2026-05-08 — it duplicated the top-right "+" (also
          // removed) and read as "follow yourself" on a self profile. Users
          // who want to find people use the dedicated chat-new entry point.
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'stretch' }}>
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

        {/* "Assistindo agora" CTA — Instagram parity. Lives outrank every
            other action on the profile, so we paint a bold red pulsing
            full-width pill below the buttons when this profile's owner is
            currently streaming. Tap routes straight to /live-viewer with the
            session id resolved by the WS-driven liveSessionId effect above.
            Hidden on self profiles (would be redundant — the user is the
            host) and when liveSessionId is null. */}
        {!actions.is_self && !!liveSessionId && (
          <LiveWatchCta
            onPress={() => {
              try {
                router?.push?.(`/live-viewer?sessionId=${encodeURIComponent(liveSessionId)}&hostEmail=${encodeURIComponent(identity.email)}&hostName=${encodeURIComponent(identity.name || (identity.email || '').split('@')[0])}`);
              } catch {}
            }}
            label={t?.('live.watchingNow') || 'Assistindo agora'}
          />
        )}
      </View>
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

        {/* Common contacts (mutual address book) */}
        {!actions.is_self && (
          <>
            <View style={{ paddingHorizontal: 8, paddingTop: 14, paddingBottom: 6, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('profile.commonContacts.title') || 'Contatos em comum'}
              </Text>
              {commonContactsData.length > 0 && (
                <Text style={{ fontSize: 11, color: colors?.textTertiary }}>
                  {(t?.('profile.commonContacts.count') || '{n} em comum').replace('{n}', String(commonContactsData.length))}
                </Text>
              )}
            </View>
            {commonContactsData.length === 0 ? (
              // TODO: backend `common_contacts` endpoint pending — until it
              // ships api.commonContacts returns [], so we surface a small
              // placeholder for parity with WhatsApp's "in common" row.
              <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                <Text style={{ fontSize: 13, color: colors?.textTertiary, fontStyle: 'italic' }}>
                  {t?.('common.comingSoon') || 'Em breve'}
                </Text>
              </View>
            ) : (
              commonContactsData.slice(0, 5).map((c) => (
                <TouchableOpacity
                  key={c.email || c.id}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 }}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (!c.email) return;
                    if (mode === 'peek') onClose?.();
                    router?.push(`/u/${encodeURIComponent(c.email)}`);
                  }}
                >
                  <AvatarCircle name={c.name || c.email} email={c.email} size={36} />
                  <Text style={{ flex: 1, fontSize: 14, color: colors?.text, fontWeight: '500' }} numberOfLines={1}>{c.name || c.email}</Text>
                  <IconChevronRight size={18} color={colors?.textTertiary} />
                </TouchableOpacity>
              ))
            )}
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
      // Lives tab — saved CF Stream replays. Shown on both own + other
      // profiles (Instagram parity: every public live replay surfaces).
      // Icon = IconPlay so it reads as "tap to watch" at a glance and
      // doesn't collide with IconFilm (used by Reels).
      { k: 'lives', label: t?.('profile.lives') || 'Lives', count: lives.length, icon: IconPlay },
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
              illustration={<EmptyGridIllustration isDark={isDark} />}
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
              illustration={<EmptyGridIllustration isDark={isDark} />}
              title={actions.is_self
                ? _ti('profile.empty.reelsSelfTitle', 'Nenhum Reel ainda')
                : _ti('profile.empty.reelsOtherTitle', 'Nenhum Reel')}
              subtitle={actions.is_self
                ? _ti('profile.empty.reelsSelfSub', 'Grave seu primeiro vídeo curto.')
                : _ti('profile.empty.reelsOtherSub', 'Os Reels aparecem aqui quando publicados.')}
              ctaLabel={actions.is_self ? _ti('profile.empty.reelsCta', 'Gravar Reel') : undefined}
              onPress={actions.is_self ? () => router?.push('/spotlight?createPost=1') : undefined}
            />
          );
        }
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {reels.map(r => <GridItem key={r.id} item={r} size={gridSize} isReel onPress={() => handleOpenPost(r, 'reels')} />)}
          </View>
        );
      }
      if (activeTab === 'lives') {
        // Initial fetch in flight — show a brief activity indicator instead
        // of jumping straight to the empty state (would feel like the user's
        // lives "disappeared" between tab presses).
        if (livesLoading && lives.length === 0) {
          return (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <ActivityIndicator color="#7C3AED" />
            </View>
          );
        }
        if (lives.length === 0) {
          return (
            <EmptyStateCard
              illustration={<EmptyGridIllustration isDark={isDark} />}
              title={actions.is_self
                ? _ti('profile.empty.livesSelfTitle', 'Sem lives salvos ainda')
                : _ti('profile.empty.livesOtherTitle', 'Sem lives salvos')}
              subtitle={actions.is_self
                ? _ti('profile.empty.livesSelfSub', 'Suas transmissões salvas vão aparecer aqui.')
                : _ti('profile.empty.livesOtherSub', 'Quando esse usuário salvar uma live, vai aparecer aqui.')}
              ctaLabel={actions.is_self ? _ti('profile.empty.livesCta', 'Iniciar live') : undefined}
              onPress={actions.is_self ? () => router?.push('/live-broadcast') : undefined}
            />
          );
        }
        const onOpenLive = (rec) => {
          if (!rec?.session_id) return;
          router?.push(`/live-replay?id=${encodeURIComponent(rec.session_id)}`);
        };
        const onLongPressLive = (rec) => {
          if (!actions.is_self) return;
          if (!rec?.session_id) return;
          // Own-profile only — host can delete their saved replay. Mirrors
          // the lives-saved.js destructive-confirm pattern so behavior is
          // consistent across the two surfaces.
          Alert.alert(
            t?.('liveReplay.deleteTitle') || 'Excluir replay?',
            t?.('liveReplay.deleteConfirm') || 'Isso vai apagar permanentemente a gravação.',
            [
              { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
              {
                text: t?.('liveReplay.deleteConfirmBtn') || 'Excluir',
                style: 'destructive',
                onPress: async () => {
                  try {
                    const res = await api.liveRecordingDelete(rec.session_id);
                    if (res?.success) {
                      setLives(prev => prev.filter(r => r.session_id !== rec.session_id));
                    }
                  } catch {}
                },
              },
            ]
          );
        };
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {lives.map((rec) => (
              <LiveGridItem
                key={rec.session_id}
                rec={rec}
                size={gridSize}
                onPress={() => onOpenLive(rec)}
                onLongPress={() => onLongPressLive(rec)}
              />
            ))}
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
            color icon + animated bottom underline that slides between tabs
            (200ms cubic-out). Falls back to text + count for contextual
            sections without a recognized icon (chat / email). */}
        <AnimatedTabBar
          tabs={tabs}
          activeKey={activeTab}
          onChange={setActiveTab}
          colors={colors}
        />

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
          principal (Instagram-style) e o tap abre direto o viewer.
          Story Highlights row (curated covers) lives between header and tabs
          em `full` mode pra parear com o layout do Instagram. Self viewers
          sempre veem o tile "Novo +" pra começar a curar. */}
      {mode === 'full' && renderHighlights()}
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

  // WAVE 95 (2026-05-21) — Tap-to-fullscreen avatar lightbox for OTHER
  // users. Was: empty StoryViewer (black screen) which never showed the
  // actual photo. Now: full-resolution profile photo with pinch-zoom,
  // swipe-down to dismiss, WhatsApp/Telegram parity.
  const avatarLightboxNode = (
    <AvatarLightbox
      visible={avatarLightboxOpen}
      email={identity?.email || null}
      uri={identity?.avatar_url || null}
      name={identity?.name || identity?.username || identity?.email || ''}
      onClose={() => setAvatarLightboxOpen(false)}
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
      onMentionPress={({ email, username }) => {
        const target = email || username;
        if (!target) return;
        setStoryViewer({ open: false, startIdx: 0 });
        setTimeout(() => { try { router?.push?.(`/u/${encodeURIComponent(target)}`); } catch {} }, 150);
      }}
    />
  );

  // [feat-10] Highlight viewer — same StoryViewer component, but driven by
  // items resolved via status_highlight_items (which side-steps the 24h
  // expires_at filter so destacados continuam acessíveis para sempre).
  const highlightViewerNode = (
    <StoryViewer
      visible={highlightViewer.open}
      stories={highlightViewer.items}
      startIdx={highlightViewer.startIdx}
      ownerName={(highlightViewer.title || (identity?.name || ''))}
      ownerEmail={identity?.email || ''}
      onClose={() => setHighlightViewer({ open: false, items: [], title: '', startIdx: 0, highlightId: null })}
      isSelf={!!actions?.is_self}
      t={t}
      onReply={async (story, text) => {
        try {
          const email = identity?.email;
          if (!email) return;
          await api.apiCall?.('status_reply', { status_id: story?.id, to_email: email, content: text }, 'POST');
        } catch {}
      }}
      onReact={async (story, emoji) => {
        try { await api.apiCall?.('status_react', { status_id: story?.id, emoji }, 'POST'); } catch {}
      }}
      onMentionPress={({ email, username }) => {
        const target = email || username;
        if (!target) return;
        setHighlightViewer({ open: false, items: [], title: '', startIdx: 0, highlightId: null });
        setTimeout(() => { try { router?.push?.(`/u/${encodeURIComponent(target)}`); } catch {} }, 150);
      }}
    />
  );

  // [2026-05-18 IG-Pro] Action sheet for highlight long-press. For owners
  // we show Edit + Share + Delete; for viewers only Share. Routing into
  // HighlightEditSheet / HighlightShareSheet keeps Profile.js lean.
  const highlightActionSheetNode = (
    <Modal
      visible={!!highlightSheet.open}
      transparent
      animationType="fade"
      onRequestClose={() => setHighlightSheet({ open: false, highlight: null })}
    >
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        onPress={() => setHighlightSheet({ open: false, highlight: null })}
      >
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            backgroundColor: colors?.background || (isDark ? '#1a1a1a' : '#fff'),
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            paddingBottom: Platform.OS === 'ios' ? 30 : 14, paddingTop: 8,
          }}
        >
          <View style={{ alignItems: 'center', paddingBottom: 8 }}>
            <View style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)' }} />
          </View>
          <Text style={{ textAlign: 'center', color: colors?.textSecondary, fontSize: 13, fontWeight: '600', paddingVertical: 8 }} numberOfLines={1}>
            {highlightSheet.highlight?.title || ''}
          </Text>
          {highlightSheet.highlight?.isSelf ? (
            <TouchableOpacity
              onPress={() => {
                const h = highlightSheet.highlight;
                setHighlightSheet({ open: false, highlight: null });
                setTimeout(() => setHighlightEdit({ open: true, highlight: h }), 50);
              }}
              style={menuItemStyle(colors)}
            >
              <IconEdit size={20} color={colors?.text} />
              <Text style={{ color: colors?.text, fontSize: 16, fontWeight: '500' }}>
                {t?.('profile.editHighlight') || 'Editar destaque'}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => {
              const h = highlightSheet.highlight;
              setHighlightSheet({ open: false, highlight: null });
              setTimeout(() => setHighlightShare({ open: true, highlight: h }), 50);
            }}
            style={menuItemStyle(colors)}
          >
            <IconShare size={20} color={colors?.text} />
            <Text style={{ color: colors?.text, fontSize: 16, fontWeight: '500' }}>
              {t?.('profile.shareHighlight') || 'Compartilhar destaque'}
            </Text>
          </TouchableOpacity>
          {highlightSheet.highlight?.isSelf ? (
            <TouchableOpacity
              onPress={() => {
                const h = highlightSheet.highlight;
                setHighlightSheet({ open: false, highlight: null });
                Alert.alert(
                  t?.('profile.deleteHighlightTitle') || 'Apagar destaque?',
                  t?.('profile.deleteHighlightHint') || 'Os status originais não são afetados.',
                  [
                    { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                    {
                      text: t?.('common.delete') || 'Apagar',
                      style: 'destructive',
                      onPress: async () => {
                        try { await api.statusHighlightDelete?.(h.id); } catch {}
                        setHighlights(prev => prev.filter(x => x.id !== h.id));
                      },
                    },
                  ]
                );
              }}
              style={menuItemStyle(colors)}
            >
              <IconTrash size={20} color="#dc2626" />
              <Text style={{ color: '#dc2626', fontSize: 16, fontWeight: '500' }}>
                {t?.('common.delete') || 'Apagar'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );

  const highlightEditNode = (
    <HighlightEditSheet
      visible={!!highlightEdit.open}
      highlight={highlightEdit.highlight}
      colors={colors}
      isDark={isDark}
      t={t}
      onClose={() => setHighlightEdit({ open: false, highlight: null })}
      onUpdated={(patch) => {
        if (!patch?.id) return;
        setHighlights(prev => prev.map(x => x.id === patch.id ? { ...x, ...patch } : x));
      }}
      onDeleted={(id) => {
        setHighlights(prev => prev.filter(x => x.id !== id));
      }}
    />
  );

  const highlightShareNode = (
    <HighlightShareSheet
      visible={!!highlightShare.open}
      highlight={highlightShare.highlight}
      colors={colors}
      isDark={isDark}
      t={t}
      onClose={() => setHighlightShare({ open: false, highlight: null })}
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
                } else {
                  // Android: Alert.prompt doesn't exist. Open our custom
                  // <NicknameEditModal> sheet (rendered below) so the user
                  // can edit. Was an empty branch before, which made the
                  // menu item look broken on Android phones.
                  setNicknameDraft(nicknameValue || '');
                  setNicknameModalOpen(true);
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
          {identity?.email && identity.email !== currentUser?.email && (
            // WhatsApp-style per-contact privacy: hide my status updates from
            // just this person without going to Settings → Privacy → Status.
            // Tapping the row anywhere flips the Switch (matches the rest of
            // the sheet's tap target). Optimistic UI, see handleToggleHideStatus.
            <TouchableOpacity
              onPress={() => handleToggleHideStatus()}
              activeOpacity={0.7}
              style={[menuItemStyle(colors), { justifyContent: 'space-between' }]}
              accessibilityRole="switch"
              accessibilityState={{ checked: hideStatusFromContact }}
              accessibilityLabel={t?.('profile.hideStatusFromContact') || 'Ocultar status deste contato'}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 }}>
                <IconEyeOff size={20} color={colors?.text} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>
                    {t?.('profile.hideStatusFromContact') || 'Ocultar status deste contato'}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }}>
                    {t?.('profile.hideStatusFromContactDesc') || 'Este contato não verá seus status'}
                  </Text>
                </View>
              </View>
              <Switch
                value={hideStatusFromContact}
                onValueChange={handleToggleHideStatus}
                disabled={hideStatusSaving}
                trackColor={{ false: '#767577', true: colors?.primary || '#25D366' }}
                thumbColor={Platform.OS === 'android' ? (hideStatusFromContact ? '#fff' : '#f4f3f4') : undefined}
              />
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

  // WhatsApp-style nickname editor — cross-platform Modal so Android
  // also has a way to rename contacts (iOS-only Alert.prompt was the
  // gap user reported as "não dá pra trocar nome").
  const nicknameModalNode = !actions.is_self && identity?.email ? (
    <Modal visible={nicknameModalOpen} transparent animationType="fade" onRequestClose={() => setNicknameModalOpen(false)}>
      <Pressable onPress={() => setNicknameModalOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Pressable onPress={(e) => e.stopPropagation?.()} style={{
          width: '100%', maxWidth: 360,
          backgroundColor: colors?.surface || '#fff',
          borderRadius: 18, padding: 20,
          borderWidth: 1, borderColor: colors?.border || 'rgba(0,0,0,0.08)',
        }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: colors?.text, marginBottom: 6 }}>
            {t?.('profile.nickname') || 'Apelido'}
          </Text>
          <Text style={{ fontSize: 13, color: colors?.textSecondary, marginBottom: 14 }}>
            {t?.('profile.nicknameHint') || 'Só você vê este nome. Pode trocar quando quiser.'}
          </Text>
          <TextInput
            value={nicknameDraft}
            onChangeText={setNicknameDraft}
            placeholder={identity?.name || identity?.email?.split('@')[0] || ''}
            placeholderTextColor={colors?.textTertiary}
            autoFocus
            maxLength={60}
            style={{
              fontSize: 16, color: colors?.text,
              borderWidth: 1, borderColor: colors?.border || 'rgba(0,0,0,0.12)',
              borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
              backgroundColor: colors?.background,
            }}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
            <TouchableOpacity
              onPress={() => setNicknameModalOpen(false)}
              style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors?.background, borderWidth: 1, borderColor: colors?.border || 'rgba(0,0,0,0.08)' }}
            >
              <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                const val = nicknameDraft.trim();
                setNicknameModalOpen(false);
                try {
                  const api = require('../services/api');
                  const { setNicknameLocal } = require('../services/nicknames');
                  await api.chatNicknameSet(identity.email, val);
                  setNicknameLocal(identity.email, val);
                  setNicknameValue(val);
                } catch {}
              }}
              style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#7C3AED' }}
            >
              <Text style={{ fontSize: 15, color: '#fff', fontWeight: '600' }}>{t?.('common.save') || 'Salvar'}</Text>
            </TouchableOpacity>
          </View>
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

  // [feat-11] Avatar action sheet — Instagram-style bottom sheet that
  // surfaces three distinct intents the tap used to overload:
  //   1) "Adicionar ao status" → opens StatusCamera (filters, stickers,
  //                              capture+gallery, all crop/edit affordances)
  //   2) "Mudar foto de perfil" → opens ProfileEditSheet which has the
  //                               avatar-edit row (existing path)
  //   3) "Ver foto" → opens story viewer pointing at a synthetic avatar item
  const handleAvatarCameraCapture = useCallback(async (capture) => {
    setStatusCameraOpen(false);
    if (!capture?.uri) return;
    setStatusPublishing(true);
    try {
      let uploadUri = capture.uri;
      let uploadType = capture.type === 'video' ? 'video/mp4' : 'image/jpeg';
      let uploadName = capture.type === 'video' ? 'status.mp4' : 'status.jpg';

      // Match ChatStatusTab's compression: ~150KB on a 4MB HEIC means
      // upload finishes before the user closes the app on cellular.
      if (capture.type === 'photo' && Platform.OS !== 'web') {
        try {
          const ImageManipulator = require('expo-image-manipulator');
          const out = await ImageManipulator.manipulateAsync(
            capture.uri,
            [{ resize: { width: 1200 } }],
            { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG }
          );
          if (out?.uri) uploadUri = out.uri;
        } catch (e) { /* fall through to original on manipulator failure */ }
      }

      const file = { uri: uploadUri, name: uploadName, type: uploadType };
      const uploadR = await api.statusUpload?.(file);
      if (uploadR?.success && uploadR.data?.url) {
        const statusType = capture.type === 'video' ? 'video' : 'image';
        const extraMeta = capture.isBoomerang ? { is_boomerang: true } : {};
        const r = await api.statusPublish?.(uploadR.data.url, statusType, '#000000', null, extraMeta);
        if (r?.success) {
          // Re-fetch the profile so the new story appears in the row + ring.
          setData(prev => prev);
          invalidateProfileCache(fetchKey);
          setRetryCounter(c => c + 1);
        } else {
          Alert.alert(t?.('common.error') || 'Erro', r?.message || t?.('status.publishFailed') || 'Não foi possível publicar.');
        }
      } else {
        Alert.alert(t?.('common.error') || 'Erro', uploadR?.message || t?.('status.uploadFailed') || 'Falha no upload.');
      }
    } catch (e) {
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falhou');
    } finally {
      setStatusPublishing(false);
    }
  }, [fetchKey, t]);

  const avatarActionNode = actions?.is_self ? (
    <Modal visible={avatarActionOpen} transparent animationType="fade" onRequestClose={() => setAvatarActionOpen(false)}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        onPress={() => setAvatarActionOpen(false)}
      >
        <Pressable
          onPress={(e) => e.stopPropagation?.()}
          style={{
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            paddingBottom: Platform.OS === 'ios' ? 30 : 14,
            paddingTop: 8,
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 6, paddingBottom: 10 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          {[
            {
              key: 'addStatus',
              label: t?.('profile.avatarAddStatus') || 'Adicionar ao status',
              hint: t?.('profile.avatarAddStatusHint') || 'Câmera + filtros, stickers e texto',
              icon: <IconPlus size={20} color={colors?.text} />,
              onPress: () => { setAvatarActionOpen(false); setStatusCameraOpen(true); },
            },
            {
              key: 'editPhoto',
              label: t?.('profile.avatarEditPhoto') || 'Mudar foto de perfil',
              hint: t?.('profile.avatarEditPhotoHint') || 'Atualizar foto, nome, bio',
              icon: <IconEdit size={20} color={colors?.text} />,
              onPress: () => { setAvatarActionOpen(false); setEditOpen(true); },
            },
            {
              key: 'viewPhoto',
              label: t?.('profile.avatarView') || 'Ver foto',
              hint: t?.('profile.avatarViewHint') || 'Em tela cheia',
              icon: <IconGrid size={20} color={colors?.text} />,
              onPress: () => {
                setAvatarActionOpen(false);
                // Open story viewer on existing stories if any; otherwise
                // synth an item from the avatar url so user sees the photo.
                if ((stories?.length || 0) > 0) {
                  setStoryViewer({ open: true, startIdx: 0 });
                } else {
                  const url = identity?.avatar_url || (identity?.email ? api.getAvatarUrlForEmail?.(identity.email) : '');
                  if (url) {
                    setHighlightViewer({
                      open: true,
                      title: identity?.name || '',
                      items: [{ id: -1, type: 'image', media_url: url, created_at: new Date().toISOString() }],
                      startIdx: 0,
                      highlightId: null,
                    });
                  }
                }
              },
            },
          ].map((row) => (
            <TouchableOpacity
              key={row.key}
              onPress={row.onPress}
              activeOpacity={0.7}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
            >
              <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
                {row.icon}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '600' }}>{row.label}</Text>
                {!!row.hint && <Text style={{ fontSize: 12, color: isDark ? '#888' : '#999', marginTop: 2 }}>{row.hint}</Text>}
              </View>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={() => setAvatarActionOpen(false)}
            activeOpacity={0.7}
            style={{ marginTop: 6, paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}
          >
            <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  ) : null;

  const statusCameraNode = actions?.is_self ? (
    <StatusCamera
      visible={statusCameraOpen}
      onClose={() => setStatusCameraOpen(false)}
      onCapture={handleAvatarCameraCapture}
      t={t}
    />
  ) : null;

  // Tiny non-blocking "Publicando…" overlay while the captured status is
  // being compressed + uploaded + published. Pinned to the bottom so it
  // doesn't cover the profile content.
  const publishingToastNode = statusPublishing ? (
    <View pointerEvents="none" style={{
      position: 'absolute', left: 16, right: 16, bottom: 24, zIndex: 9999,
      paddingVertical: 12, paddingHorizontal: 16,
      borderRadius: 24,
      backgroundColor: isDark ? 'rgba(20,20,20,0.94)' : 'rgba(255,255,255,0.96)',
      flexDirection: 'row', alignItems: 'center', gap: 12,
      ...Platform.select({
        ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 8 },
        android: { elevation: 6 },
        web: { boxShadow: '0 4px 12px rgba(0,0,0,0.18)' },
      }),
    }}>
      <ActivityIndicator size="small" color="#7C3AED" />
      <Text style={{ fontSize: 14, color: colors?.text, fontWeight: '500' }}>
        {t?.('status.publishing') || 'Publicando…'}
      </Text>
    </View>
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

  // 2026-05-18 — Diamond gift sheet for non-self profiles. Anchored to
  // the viewed user; opens from the "Enviar diamante" chip rendered in
  // the action-row block above.
  const sendDiamondNode = !actions.is_self && identity?.email ? (
    <SendDiamondSheet
      visible={sendDiamondOpen}
      onClose={() => setSendDiamondOpen(false)}
      toEmail={identity.email}
      toName={identity.name || nicknameValue || identity.email.split('@')[0]}
      toAvatarUrl={identity.avatar_url}
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
        {avatarLightboxNode}
        {highlightViewerNode}
        {highlightActionSheetNode}
        {highlightEditNode}
        {highlightShareNode}
        {editNode}
        {avatarActionNode}
        {statusCameraNode}
        {publishingToastNode}
        {settingsNode}
        {sendDiamondNode}
        {followersNode}
        {menuNode}
        {nicknameModalNode}
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
      {avatarLightboxNode}
      {highlightViewerNode}
      {highlightActionSheetNode}
      {highlightEditNode}
      {highlightShareNode}
      {editNode}
      {avatarActionNode}
      {statusCameraNode}
      {publishingToastNode}
      {settingsNode}
      {sendDiamondNode}
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
