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

import NativeSwitch from './NativeSwitch'; // [2026-10-07 app-feel-ui] themed native toggle
import { androidBottomInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Image, FlatList,
  Platform, Modal, Pressable, ActivityIndicator, Dimensions, Animated, Alert, TextInput,
  PanResponder, Easing, Switch, Linking, AppState, DeviceEventEmitter, InteractionManager,
} from 'react-native';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import { normalizeCoverUrl } from '../services/profileCover';
import { getCachedEntrySync, setCache, hasCacheUser, cacheUserScope, invalidate as _invalidateCached } from '../services/cache';
import { cachedKey, CACHED_MAX_AGE } from '../hooks/useCachedAction';
import { profileCacheKey } from '../services/screenData';
import { computeContentMaxWidth } from '../utils/responsive';
// [2026-10-16 native-media-grid] grade do perfil NATIVA (kill __chatyy_native_media_grid)
import NativeMediaGrid, { isNativeMediaGridAvailable, compactCount as _mgCount, formatDuration as _mgDur } from './media/NativeMediaGrid';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from './AvatarCircle';
import AvatarLightbox from './AvatarLightbox';
import StoryRingAvatar from './status/StoryRingAvatar';
import { useStatusRing, primeStatusRings } from './status/statusRingStore'; // [status-rever 2026-10-14]
import StoryViewer from './status/StoryViewer';
import StatusCamera from './StatusCamera';
import ProfilePostViewer from './ProfilePostViewer';
import ProfileEditSheet from './ProfileEditSheet';
import ProfileSettingsSheet from './ProfileSettingsSheet';
import FollowersSheet from './FollowersSheet';
import ScreenEmptyState from './ScreenEmptyState'; // [2026-10-14] vazio P&B (era mosaico cinza)
import { Shimmer } from './SkeletonLoader'; // [2026-10-16 polish-perfil] grade-skeleton das Lives
import SendDiamondSheet from './SendDiamondSheet';
import { haptic } from '../constants/theme';
// [2026-10-16 motion] Molas/limiares canônicos (constants/motion).
import { Springs, motionEnabled, springTo } from '../constants/motion'; // [2026-10-17 drag-dismiss]
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragBackdrop } from './ui/useDragToDismiss';
// Press-in pula com movimento reduzido (= PressableScale); soltar sempre volta a 1.
function _pressSpring(v, to) {
  if (to !== 1 && !motionEnabled('press')) return;
  springTo(v, to, to === 1 ? 'release' : 'press').start();
}
import { useWallet, refreshWallet } from '../services/diamonds';
import { humanizeCount as _humanizeDiamonds } from './gifts/giftCatalog';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { DIAMONDS_ENABLED } from '../constants/featureFlags';
import HighlightEditSheet from './HighlightEditSheet';
import ReportSheet from './ReportSheet'; // [central-moderacao 2026-10-14] motivos padronizados
import NativeChatInfo, { isNativeProfileEnabled, isNativeProfileV5Enabled, chatInfoV6 } from './chat/NativeChatInfo'; // [2026-10-18 profile-native] + [2026-10-19 profile-grid-native] api 5
import { buildNativeProfileInfo } from './profile/nativeProfileInfo'; // [2026-10-18 profile-native]
import { ProfilePhotoGalleryHost } from './profile/ProfilePhotoGallery'; // [perfil-fotos 2026-10-19]
import * as ProfilePhotos from '../services/profilePhotos'; // [perfil-fotos 2026-10-19] galeria + publicar no perfil
import { useNativeProfileEdit, isNativeProfileEditEnabled } from './profile/nativeProfileEdit'; // [2026-10-18 profile-edit-native]
import ProfileMediaStudio from './profile/ProfileMediaStudio'; // [2026-10-21 foto-capa-studio]
import { PLAN_NAME } from '../services/brandPlan'; // [2026-10-18 profile-native]
import HighlightShareSheet from './HighlightShareSheet';
// [post-perfil 2026-10-20] post otimista (fila durável) no topo da grade + cartão de progresso.
import ProfilePostProgress, { usePendingProfilePosts, mergePendingPosts, openPendingPostMenu } from './ProfilePostProgress';
import { ProfileHighlightMenuSheet, ProfileMoreMenuSheet, ProfileNicknameDialog, ProfileAvatarActionsSheet, profileNativeSheetsOn } from './profile/ProfileSheets'; // [2026-10-18 profile-sheets]
import {
  IconX, IconPhone, IconVideo, IconMail, IconMessageSquare, IconUserPlus,
  IconChevronRight, IconSettings, IconMoreHorizontal, IconShare, IconAlertTriangle, IconLock, IconEdit, IconUser,
  IconTrash, IconPlus, IconGrid, IconFilm, IconTag, IconCheck, IconEyeOff, IconLink, IconPlay, IconImage,
  IconGiftBox, IconBrush, IconBriefcase, IconDiamond,
} from './Icons';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
const IconEdit3 = IconEdit;
const IconTrash2 = IconTrash;

// Gradient halo + empty illustration. Loaded lazily so a missing peer dep
// can't crash the screen — fall back to plain View borders when unavailable.
let _Svg = null, _SvgDefs = null, _SvgLinearGradient = null, _SvgStop = null, _SvgCircle = null, _SvgPath = null, _SvgRect = null;
try {
  const _svg = require('react-native-svg');
  _Svg = _svg.Svg || _svg.default;
  _SvgDefs = _svg.Defs;
  _SvgLinearGradient = _svg.LinearGradient;
  _SvgStop = _svg.Stop;
  _SvgCircle = _svg.Circle;
  _SvgPath = _svg.Path;
  _SvgRect = _svg.Rect;
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

// [B.2] Highlights cache — keyed by owner email. Re-opening a profile paints
// the destaques strip INSTANTLY from this in-memory cache (IG-grade: no
// skeleton flash, no N+1 refetch on every open). refetchHighlights still runs
// in the background to revalidate; the cached strip just removes the cold-start
// spinner. Cleared together with the profile cache below.
const _highlightsCache = new Map(); // email -> { list, ts }
const HIGHLIGHTS_TTL_MS = 5 * 60 * 1000;
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

// [2026-10-14 offline-first] Disco = services/cache.js (chave escopada pela
// CONTA ativa, 7 dias, LRU). O antigo `profile_v1:<id>` NÃO tinha conta na
// chave (is_following/apelido da conta A pintavam na conta B) → migrado; as
// chaves legadas são apagadas uma vez. Memória também escopada pela conta.
function _memKey(id) { return cacheUserScope() + '|' + id; }
function _purgeLegacyProfileKeys() {
  try {
    const mmkv = _getMmkv();
    mmkv?.getAllKeys?.()?.forEach?.(k => { if (k.startsWith(PROFILE_MMKV_PREFIX)) mmkv.remove?.(k); });
  } catch {}
}
setTimeout(_purgeLegacyProfileKeys, 15000);

export function invalidateProfileCache(key) {
  if (key == null) {
    for (const k of Array.from(_profileCache.keys())) {
      try { const id = k.slice(k.indexOf('|') + 1); _invalidateCached(cachedKey(profileCacheKey(id))); } catch {}
    }
    _profileCache.clear();
    try { _highlightsCache.clear(); } catch {}
    _purgeLegacyProfileKeys();
    return;
  }
  const k = String(key).toLowerCase();
  _profileCache.delete(_memKey(k));
  try { _highlightsCache.delete(k); } catch {}
  try { _invalidateCached(cachedKey(profileCacheKey(k))); } catch {}
}

/**
 * [post-perfil 2026-10-20] Cópia VENCIDA (não apagada): o Perfil pinta dela na hora e já
 * revalida em 2º plano. Apagar (invalidateProfileCache) fazia a tela piscar o esqueleto /
 * semente a cada publicação. key=null → todas as cópias desta sessão.
 */
export function markProfileCacheStale(key) {
  try {
    if (key == null) { for (const e of _profileCache.values()) { if (e) e.ts = 0; } return; }
    const e = _cacheGet(key);
    if (e) e.ts = 0;
  } catch {}
}

function _infoCacheOn() {
  try { return globalThis.__chatyy_info_cache !== false; } catch { return true; }
}

// [2026-10-19 profile-native-first] kill switch OTA do perfil nativo imediato.
function _profileNativeFirstOn() {
  try { return globalThis.__chatyy_profile_native_first !== false; } catch { return true; }
}

// [2026-10-19 profile-native-first] Semente do 1º quadro nativo quando ainda
// não há cópia do profile_get: eu mesmo (conta ativa) → contato salvo no
// infoCache (nome, recado, capa, foto) → só o @/e-mail da rota.
function _seedProfileIdentity(key, me) {
  const k = String(key || '').trim();
  if (!k) return null;
  const kl = k.toLowerCase().replace(/^@/, '');
  const isEmail = kl.includes('@');
  const meEmail = String(me?.email || '').toLowerCase();
  const meUser = String(me?.username || '').toLowerCase().replace(/^@/, '');
  if (meEmail && (isEmail ? kl === meEmail : (meUser && kl === meUser))) {
    return {
      email: me.email,
      name: String(me.name || me.display_name || ''),
      username: String(me.username || ''),
      avatar_url: me.avatar_url || '',
      __self: true,
    };
  }
  if (isEmail) {
    let c = null;
    try { c = require('../services/infoCache').getContactInfo(kl); } catch { c = null; }
    const id = (c && c.identity && typeof c.identity === 'object') ? c.identity : {};
    return { ...id, email: id.email || kl };
  }
  return { username: kl };
}

function _cacheGet(key) {
  if (!key || !hasCacheUser()) return null;
  const id = String(key).toLowerCase();
  const hit = _profileCache.get(_memKey(id));
  if (hit) return hit;
  // Hydrate from disk on demand (sync).
  // [2026-10-19 info-cache] cópia vale 60 dias (antes 7): perfil de quem você não
  // abre há semanas ainda pinta na hora (bio/capa/contagens) e revalida em 2º plano.
  try {
    const e = getCachedEntrySync(cachedKey(profileCacheKey(id)), _infoCacheOn() ? 60 * 24 * 3600 * 1000 : CACHED_MAX_AGE);
    if (e && e.data) {
      const entry = { data: e.data, ts: e.ts || 0 };
      _profileCache.set(_memKey(id), entry);
      return entry;
    }
  } catch {}
  return null;
}

function _cacheSet(key, data) {
  if (!key || !hasCacheUser()) return;
  const id = String(key).toLowerCase();
  const entry = { data, ts: Date.now() };
  _profileCache.set(_memKey(id), entry);
  try { setCache(cachedKey(profileCacheKey(id)), data, CACHED_MAX_AGE); } catch {}
}

// Lazy expo-image for disk-cached grid/story thumbnails (avoids blank flicker
// when re-opening a profile). Falls back to react-native Image if unavailable.
let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}
// [2026-10-15 profile-virt] Grade do perfil (modo full) virtualizada em FlashList:
// so as linhas visiveis montam; o cabecalho vira ListHeaderComponent.
let _FlashList = null;
try { _FlashList = require('@shopify/flash-list').FlashList; } catch {}

// [2026-10-15 profile-fast] profile_get em voo compartilhado. A rota /u/[username]
// dispara isto na avaliacao do chunk (web: ~250 ms antes do 1o render do Profile);
// o efeito de carga reaproveita a mesma promise em vez de abrir outra requisicao.
const _profileInflight = new Map();
export function prefetchProfile(key) {
  if (!key) return null;
  const k = String(key);
  const hit = _profileInflight.get(k);
  if (hit) return hit;
  try {
    const c = _cacheGet(k);
    if (c && Date.now() - c.ts < PROFILE_TTL_MS) return null; // cache fresco: nada a buscar
  } catch {}
  let pr = null;
  try { pr = api.profileGet(k); } catch { pr = null; }
  if (!pr || typeof pr.then !== 'function') return null;
  _profileInflight.set(k, pr);
  const drop = () => { if (_profileInflight.get(k) === pr) _profileInflight.delete(k); };
  pr.then((r) => { if (r && r.success) setTimeout(drop, 3000); else drop(); }, drop);
  return pr;
}

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
  if (/^(file|content|ph|assets-library|data|blob):/i.test(url)) return url; // [post-perfil 2026-10-20] post otimista (arquivo local)
  return api.getMediaUrl(url);
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
const FlatButton = memo(function FlatButton({ label, onPress, isPrimary, colors, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() => {
    _pressSpring(scale, 0.96);
  }, [scale]);
  const onPressOut = useCallback(() => {
    _pressSpring(scale, 1);
  }, [scale]);
  // CLEAN 2026 premium: the secondary button is now a soft *filled* surface
  // (not a thin outline) with a 12px rounded-rect corner — reads as a modern
  // segmented control (Instagram "Editar perfil" / "Compartilhar") instead of
  // a hollow pill. Black lives ONLY on the primary CTA fill; the neutral fill
  // keeps the row airy while giving each button a tangible, tappable surface.
  const secondaryFill = colors?.surfaceVariant
    || (isDark ? 'rgba(255,255,255,0.09)' : 'rgba(15,23,42,0.055)');
  return (
    <Animated.View style={{
      flex: 1,
      transform: [{ scale }],
      // Subtle lift only for the primary CTA — soft, no heavy black glow.
      ...(isPrimary && Platform.OS !== 'web' ? {
        // [2026-10-13 visual] sombra só no claro — no escuro o CTA é claro
        // (invertido) e a sombra preta sobre #000 só sujava a borda.
        shadowColor: '#000000',
        shadowOpacity: isDark ? 0 : 0.12,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
        elevation: isDark ? 0 : 3,
      } : {}),
    }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={{ top: 4, bottom: 4 }}
        style={{
          paddingVertical: 9,
          paddingHorizontal: 14,
          borderRadius: 10, // modern rounded-rect (segmented control feel)
          minHeight: 38,
          alignItems: 'center',
          justifyContent: 'center',
          // [2026-10-13 visual] P&B invertido no escuro: #111 sobre fundo #000
          // ficava praticamente invisível → usa primary/onPrimary do tema.
          backgroundColor: isPrimary ? (colors?.primary || '#111111') : secondaryFill,
          borderWidth: 0,
        }}
      >
        <Text style={{
          fontSize: 14,
          fontWeight: '600',
          letterSpacing: 0.2,
          color: isPrimary ? (colors?.onPrimary || '#fff') : (colors?.text || (isDark ? '#fff' : '#111')),
        }} numberOfLines={1}>
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
});

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
        onPressIn={() => { if (motionEnabled('press')) springTo(press, 1, 'press').start(); }}
        onPressOut={() => springTo(press, 0, 'release').start()}
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
// [2026-10-14 carteira-discreta] Saldo de diamantes como 3º botão compacto da
// linha "Editar perfil · Compartilhar" (mesmo preenchimento suave, sem borda) —
// estilo TikTok/Instagram: discreto, 1 toque até a Carteira, só no próprio perfil.
const ProfileWalletChip = memo(function ProfileWalletChip({ colors, isDark, t, onPress }) {
  // [2026-10-15 carteira-v2] Cartão P&B premium abaixo de "Editar · Compartilhar"
  // (antes: pílula com diamante azul espremida na linha). Glifo monocromático,
  // saldo grande tabular, rótulo e chevron — 1 toque até a Carteira.
  const w = useWallet();
  useEffect(() => { refreshWallet(); }, []);
  const scale = useRef(new Animated.Value(1)).current;
  if (w.loaded && !w.enabled) return null;
  const has = typeof w.diamonds === 'number';
  const label = t?.('wallet.title') || 'Carteira';
  const sub = t?.('wallet.diamondsAvailable') || 'diamantes disponíveis';
  const fg = isDark ? '#FFFFFF' : '#0B0B0C';
  const muted = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(11,11,12,0.52)';
  const cardBg = isDark ? '#141416' : '#F4F4F5';
  const glyphBg = isDark ? '#FFFFFF' : '#0B0B0C';
  const glyphFg = isDark ? '#0B0B0C' : '#FFFFFF';
  const S = (() => { try { return require('react-native-svg'); } catch { return null; } })();
  const press = (v) => _pressSpring(scale, v);
  return (
    <Animated.View style={{ transform: [{ scale }], marginTop: 10 }}>
      <TouchableOpacity
        onPress={() => { try { haptic.light(); } catch {} onPress?.(); }}
        onPressIn={() => press(0.975)}
        onPressOut={() => press(1)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={has ? `${label}: ${w.diamonds} ${sub}` : label}
        testID="profile-wallet-card"
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 12,
          backgroundColor: cardBg, borderRadius: 16, paddingVertical: 11, paddingLeft: 11, paddingRight: 12,
          borderWidth: isDark ? StyleSheet.hairlineWidth : 0, borderColor: 'rgba(255,255,255,0.10)',
          ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null),
        }}
      >
        <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: glyphBg, alignItems: 'center', justifyContent: 'center', ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null) }}>
          {S ? (
            <S.default width={18} height={18} viewBox="0 0 24 24">
              <S.Path d="M6.5 3.5h11l4 5.5L12 20.5 2.5 9l4-5.5Z" fill="none" stroke={glyphFg} strokeWidth={1.7} strokeLinejoin="round" />
              <S.Path d="M2.8 9h18.4M9 3.8 12 9l3-5.2M12 9v11" fill="none" stroke={glyphFg} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
            </S.default>
          ) : <IconDiamond size={16} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: muted, fontSize: 12.5, fontWeight: '600', letterSpacing: 0.1 }} numberOfLines={1}>{label}</Text>
          <Text style={{ color: fg, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, marginTop: 1, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
            {has ? `${_humanizeDiamonds(w.diamonds)} ` : '— '}
            <Text style={{ color: muted, fontSize: 13.5, fontWeight: '500', letterSpacing: 0 }}>{sub}</Text>
          </Text>
        </View>
        <IconChevronRight size={18} color={muted} />
      </TouchableOpacity>
    </Animated.View>
  );
});

const ChipButton = memo(function ChipButton({ icon: Icon, label, onPress, colors, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  // Clean light hairline (colors.border) instead of a dark tinted outline.
  const outlineColor = colors?.border || (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)');
  return (
    <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={() => _pressSpring(scale, 0.96)}
        onPressOut={() => _pressSpring(scale, 1)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 12, // rounded-rect — matches FlatButton family
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
});

const ActionButton = memo(function ActionButton({ icon: Icon, label, onPress, colors, isPrimary }) {
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
        backgroundColor: isPrimary ? (colors?.primary || '#111111') : (colors?.surfaceVariant || colors?.surface || '#f4f4f4'),
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={20} color={isPrimary ? (colors?.onPrimary || '#fff') : (colors?.text || '#111')} />
      </View>
      <Text style={{ fontSize: 11, color: colors?.text || '#111', fontWeight: '500' }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
});

// ─── Stat column ──────────────────────────────────────────────────────
const Stat = memo(function Stat({ value, label, onPress, colors }) {
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
    _pressSpring(scale, 0.94);
  }, [onPress, scale]);
  const onPressOut = useCallback(() => {
    if (!onPress) return;
    _pressSpring(scale, 1);
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
        {/* [2026-10-10 settings-polish] Instagram: rótulo 13 em caixa normal, cor do
            texto. O CAIXA-ALTA 11.5 cinza encostava nos divisores ("SEGUIDORES"). */}
        <Text numberOfLines={1} style={{
          fontSize: 13, color: colors?.text,
          marginTop: 2, fontWeight: '400',
        }}>
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
});

// ─── Empty-state illustration ─────────────────────────────────────────
// Subtle 3-tile-mosaic SVG that lives where the posts grid would be.
// Reads as "no photos here yet" without leaning on a literal camera icon.
// Renders at very low opacity so it sinks into the background — the title
// and CTA stay the focal point.
const EmptyGridIllustration = memo(function EmptyGridIllustration({ isDark, size = 120 }) {
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
  const accent = isDark ? 'rgba(17, 17, 17,0.30)' : 'rgba(17, 17, 17,0.20)';
  return (
    <_Svg width={size} height={size} viewBox="0 0 120 120">
      {/* Two mosaic tiles + one accent tile in brand purple */}
      <_SvgPath d="M14 14 H56 V56 H14 Z" fill={tone} />
      <_SvgPath d="M64 14 H106 V56 H64 Z" fill={tone} opacity={0.7} />
      <_SvgPath d="M14 64 H56 V106 H14 Z" fill={accent} />
      {/* Small "plus" hint inside accent tile */}
      <_SvgPath
        d="M35 78 V92 M28 85 H42"
        stroke={isDark ? '#F5F5F7' : '#111111'}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <_SvgPath d="M64 64 H106 V106 H64 Z" fill={tone} opacity={0.45} />
    </_Svg>
  );
});

// ─── Live recording grid tile ────────────────────────────────────────
// Used by the Lives profile tab. Mirrors the Reels GridItem look (full-
// bleed 1:1 cell, hairline gutters) but layers a duration chip + view
// count overlay so the user can scan their saved replays. Long-press on
// own profile opens the delete confirm (wired in renderTabContent).
const LiveGridItem = memo(function LiveGridItem({ rec, size, onPress, onLongPress, t }) {
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
      // [2026-10-10 lives-2] parse robusto (Z, "+00", fração longa, sem fuso = UTC)
      const d = api.parseServerDate(raw);
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
      accessibilityLabel={rec?.title || t?.('live.live') || 'Live'}
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
            {t?.('live.live') || 'AO VIVO'}{dateLabel ? ` · ${dateLabel}` : ''}
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
          <View style={{ position: 'absolute', bottom: 6, left: 6, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <IconPlay size={10} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 }}>
              {viewLabel}
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
});

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
    // [2026-10-16 motion] indicador desliza com mola (Telegram) — interrompível.
    Animated.parallel([
      springTo(indicatorX, activeIdx * slotW, 'snappy', { useNativeDriver: true }),
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
      {/* Sliding underline — Instagram-grade: full-slot width, theme-aware
          accent (was hardcoded #111111 → invisible on dark backgrounds),
          slightly thicker (2.5px) so it reads from a glance. Lives on the GPU
          via translateX. */}
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
            backgroundColor: accent,
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
const GridItem = memo(function GridItem({ item, size, onPress, isReel }) {
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
  // Grid media can 404 permanently — legacy posts whose R2 objects were lost in
  // the pre-migration media purge (old `/data/feed-files/<id>/…` layout). When
  // the thumb/poster never loads we must fall back to a neutral placeholder
  // instead of leaving a pure-black tile (user reported @aleffduarte's grid as
  // all-black squares). Theme-agnostic mid-gray + faint glyph reads as "media
  // unavailable" on both light and dark, and ONLY shows on real load failure —
  // a working thumbnail still paints normally (never a permanent placeholder).
  const [imgFailed, setImgFailed] = React.useState(false);
  const placeholder = (
    <View style={{ width: '100%', height: '100%', borderRadius: 3, backgroundColor: '#8e8e93', alignItems: 'center', justifyContent: 'center' }}>
      {/* IconImage (photo glyph) reads as "media unavailable" better than the
          generic grid glyph — a dead-media tile should look like a missing
          photo, not a layout element. Neutral mid-gray (not black) on purpose. */}
      <IconImage size={20} color="rgba(255,255,255,0.6)" />
    </View>
  );
  const renderImg = () => {
    if (!url || imgFailed) return placeholder;
    if (WEB) {
      // [2026-10-11 social-qa] profile_get manda `thumbnail` = poster JPG do
      // reel (…/reel_x.thumb.jpg). Antes isso ia pro <video src>, que dava
      // erro → tile cinza "mídia indisponível" em TODO reel do grid no web.
      // Se a thumb já é imagem, pinta <img> (igual ao nativo).
      if (looksLikeVideo && thumbIsImage) {
        return <img src={url} width={size} height={size} onError={() => setImgFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3 }} alt="" loading="lazy" decoding="async" />;
      }
      if (looksLikeVideo) {
        return (
          <video
            src={url + '#t=0.1'}
            preload="metadata"
            muted
            playsInline
            poster={guessedPosterUrl || undefined}
            onError={() => setImgFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3, background: '#111' }}
          />
        );
      }
      return <img src={url} width={size} height={size} onError={() => setImgFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3 }} alt="" loading="lazy" decoding="async" />;
    }
    if (looksLikeVideo) {
      // Try the ffmpeg-generated sibling poster (`<video>.thumb.jpg`). If
      // that 404s (legacy reel uploaded before the backfill ran), fall
      // back to the neutral placeholder — the video badge is rendered above it.
      if (guessedPosterUrl && !posterFailed && _ExpoImage) {
        return (
          <_ExpoImage
            source={{ uri: guessedPosterUrl }}
            recyclingKey={guessedPosterUrl}
            style={{ width: '100%', height: '100%', borderRadius: 3 }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            onError={() => setPosterFailed(true)}
          />
        );
      }
      return placeholder;
    }
    if (_ExpoImage) {
      return (
        <_ExpoImage
          source={{ uri: url }}
          recyclingKey={url}
          style={{ width: '100%', height: '100%', borderRadius: 3 }}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
          onError={() => setImgFailed(true)}
        />
      );
    }
    return <Image source={{ uri: url }} onError={() => setImgFailed(true)} style={{ width: '100%', height: '100%', borderRadius: 3 }} resizeMode="cover" />;
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
                flexDirection: 'row', alignItems: 'center', gap: 3,
              }}>
                <IconPlay size={10} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 }}>
                  {viewLabel}
                </Text>
              </View>
            )}
          </>
        )}
      </View>
    </TouchableOpacity>
  );
});


// [2026-10-16 native-media-grid] Tile -> item compacto da grade nativa
// (mesmas regras de miniatura/selos do GridItem/LiveGridItem acima).
function _nativeTileKey(it, kind) {
  if (kind === 'lives') return 'l:' + String(it?.session_id || it?.id || '');
  return String(it?.id ?? '') + '-' + String(it?.type || '');
}
function _toNativeTile(it, kind, t) {
  const k = _nativeTileKey(it, kind);
  if (kind === 'lives') {
    let dateLabel = '';
    try {
      const raw = it?.ended_at || it?.started_at;
      if (raw) {
        const d = api.parseServerDate(raw);
        if (!isNaN(d.getTime())) dateLabel = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
    } catch {}
    const liveLbl = t?.('live.live') || 'AO VIVO';
    return {
      k,
      u: it?.thumbnail_url ? resolveMedia(it.thumbnail_url) : '',
      tl: liveLbl + (dateLabel ? ` · ${dateLabel}` : ''),
      tld: true,
      tr: 'play',
      bl: _mgCount(it?.viewer_count || it?.view_count || it?.views || 0),
      blp: true,
      br: _mgDur(it?.duration || 0),
      a: it?.title || liveLbl,
    };
  }
  const rawThumb = it?.thumbnail || it?.url || '';
  const url = resolveMedia(rawThumb);
  const isReel = kind === 'reels' || (kind === 'posts' && (it?.type === 'video' || it?.media_type === 'video'));
  const looksLikeVideo = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(url) || it?.type === 'video' || it?.media_type === 'video' || isReel;
  const thumbIsImage = /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(rawThumb);
  if (looksLikeVideo) {
    const poster = url ? (thumbIsImage ? url : resolveMedia(rawThumb + '.thumb.jpg')) : '';
    const videoUrl = url && !thumbIsImage ? url : '';
    const showBadge = it?.type === 'video' || isReel;
    return {
      k, u: poster, vu: videoUrl, v: true,
      tr: showBadge ? 'video' : '',
      bl: showBadge ? _mgCount(it?.view_count || it?.views || it?.play_count || 0) : '',
      blp: true,
      a: it?.caption || '',
    };
  }
  const multi = Number(it?.count || (Array.isArray(it?.media_urls) ? it.media_urls.length : 0)) > 1;
  return { k, u: url, tr: multi ? 'multi' : '', a: it?.caption || '' };
}

// [2026-10-15 profile-virt] Uma linha (ate 3 tiles) da grade virtualizada. memo:
// re-render do cabecalho (presenca, live, destaques...) nao re-renderiza os tiles.
const ProfileGridRow = memo(function ProfileGridRow({ row, size, kind, onItemPress, onItemLongPress, onCreate, createLabel, isDark, t }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {row.items.map((it, i) => {
        if (it && it.__create) {
          return (
            <Pressable
              key="__create"
              onPress={onCreate}
              accessibilityRole="button"
              accessibilityLabel={createLabel}
              style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? '#2A2A2A' : '#E5E5E5', backgroundColor: isDark ? '#0A0A0A' : '#FAFAFA' }}
            >
              <IconPlus size={26} color={isDark ? '#F1F3F5' : '#111111'} />
              <Text style={{ color: isDark ? '#F1F3F5' : '#111111', fontSize: 13, fontWeight: '700' }}>{createLabel}</Text>
            </Pressable>
          );
        }
        if (kind === 'lives') {
          return (
            <LiveGridItem
              key={it.session_id || i}
              rec={it}
              size={size}
              onPress={() => onItemPress(it, kind)}
              onLongPress={() => onItemLongPress(it, kind)}
              t={t}
            />
          );
        }
        const vid = it.type === 'video' || it.media_type === 'video';
        return (
          <GridItem
            key={`${it.id ?? i}-${it.type || ''}`}
            item={it}
            size={size}
            isReel={kind === 'reels' || (kind === 'posts' && vid)}
            onPress={() => onItemPress(it, kind)}
          />
        );
      })}
    </View>
  );
});
const _gridRowKey = (r) => r.key;
const _EMPTY_ROWS = [];
const _EMPTY_NATIVE_GRID = { items: _EMPTY_ROWS, byKey: new Map(), kind: null };

// ─── Status camera boundary ─────────────────────────────────────────
// 2026-05-28 Lester QA: clicking "Adicionar ao status" on the avatar
// crashed the whole app. StatusCamera uses React.lazy + Suspense for
// StatusVisionCamera — that handles the loading state, but does NOT
// catch runtime errors (a missing native module on an older build, a
// frame-processor throwing, etc). A bare class component catching the
// error + calling onCrash to dismiss the sheet keeps the profile alive.
class ProfileStatusCameraBoundary extends React.Component {
  constructor(props) { super(props); this.state = { crashed: false }; }
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(err) {
    try { console.warn('[Profile/StatusCamera] crashed', err?.message || err); } catch {}
    // [2026-06-04] era './services/...' — caminho errado (Profile mora em
    // components/), o require lançava e o catch engolia: crash nunca chegava
    // na telemetria (caçada R2).
    try { require('../services/crashReporter')?.reportCrash?.({ type: 'render_error', context: 'profile_status_camera', message: err?.message, stack: err?.stack }); } catch {}
    try { this.props.onCrash?.(); } catch {}
  }
  render() { return this.state.crashed ? null : this.props.children; }
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
  // [2026-10-18 profile-native] perfil Telegram NATIVO (view ChatyyChatInfo api ≥ 3).
  nativeProfile = false,   // rota pede o nativo (modo full); a grade JS completa vem por ?grid=1
  onNativeActive,          // (bool) → a rota esconde o próprio botão voltar quando o nativo desenha a barra
  nativeBottomInset = 0,   // respiro inferior (safe area) da lista nativa
  autoEdit = false,        // [2026-10-18 profile-edit-native] /u/<me>?edit=1 → abre direto no modo edição nativo
  onNativeEditActive,      // (bool) → a rota trava o gesto de voltar enquanto edita
  initialTab,              // aba inicial da grade JS ('posts' | 'reels' | 'lives' | 'media')
  colors, isDark, t, router,
}) {
  // [2026-10-18 profile-sheets] arrasto/estado das folhas (destaque, mais, apelido, avatar)
  // moraram aqui até 18/10 — agora em components/profile/ProfileSheets.js (estado local).
  // Current session's user — needed so the embedded FeedComments sheet
  // knows whose avatar to stamp on new comments. Kept internal so callers
  // don't have to pass user through every layer.
  const { user: currentUser, logout: authLogout } = useAuth() || {};
  const fetchKey = email || username;

  // Seed state from cache so the first paint is instant when re-opening a
  // profile within TTL. Network revalidation still runs below.
  const [data, setData] = useState(() => _cacheGet(fetchKey)?.data || null);
  const [coverFailedUrl, setCoverFailedUrl] = useState(""); // [capa-2026-10-19]
  const [loading, setLoading] = useState(() => !_cacheGet(fetchKey));
  const [err, setErr] = useState(null);
  // 401 surfaces as an "expired session" state with a Sign-out CTA instead of
  // bare "Not authenticated" text — that string was leaking on the profile
  // route when bearer/cookie went stale (incidente 2026-05-04 prints).
  const [errStatus, setErrStatus] = useState(0);
  const [retryCounter, setRetryCounter] = useState(0);
  // [perfil-publicar 2026-10-19] publicou / editou / excluiu um post (compositor ou
  // visualizador) → o MEU perfil aberto recarrega a grade (antes só no próximo abrir).
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('chatyy:profilePostsChanged', () => {
      try {
        const me = String(currentUser?.email || '').toLowerCase();
        const fk = String(fetchKey || '').toLowerCase();
        const idEm = String(data?.identity?.email || '').toLowerCase();
        if (!me || (fk !== me && idEm !== me && fk !== 'me')) return;
        markProfileCacheStale(fetchKey); // [post-perfil 2026-10-20] vencida, não apagada (sem piscar)
        morePostsRef.current = { key: fetchKey, page: 0, hasMore: true, loading: false };
        setMorePosts([]);
        setRetryCounter((c) => c + 1);
      } catch {}
    });
    return () => { try { sub.remove(); } catch {} };
  }, [currentUser?.email, fetchKey, data?.identity?.email]); // eslint-disable-line react-hooks/exhaustive-deps
  const [activeTab, setActiveTab] = useState(() => (['posts', 'reels', 'lives', 'media', 'email'].includes(initialTab) ? initialTab : 'posts'));
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
  // [2026-10-18 profile-native] foto do carrossel (capa) aberta em tela cheia; null = avatar.
  const [lightboxUri, setLightboxUri] = useState(null);
  // [2026-10-18 profile-native] erro na view nativa → esta tela volta ao perfil JS.
  const [nativeProfileOff, setNativeProfileOff] = useState(false);
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
  // [B.2] Seed from the highlights cache so re-opening a profile within TTL
  // paints the strip instantly (no skeleton). Keyed by the `email` prop when
  // available (full-profile route); username-only opens hydrate via effect once
  // identity resolves. refetchHighlights still revalidates in the background.
  const _hlSeed = (() => {
    try {
      const k = String(email || '').toLowerCase();
      const c = k && _highlightsCache.get(k);
      if (c && Array.isArray(c.list) && (Date.now() - c.ts) < HIGHLIGHTS_TTL_MS) return c.list;
    } catch {}
    return null;
  })();
  const [highlights, setHighlights] = useState(_hlSeed || []);
  // [WAVE 52 / 2026-05-21] Loading state powers the skeleton row that paints
  // 4 shimmer circles while the first statusHighlightList resolves — IG shows
  // the strip outline immediately on profile open, never a blank gap. When we
  // had a cache hit, start NOT loading so the cached strip shows immediately.
  const [highlightsLoading, setHighlightsLoading] = useState(!_hlSeed);
  // [2026-05-18 IG-Pro] Action sheet + edit/share modals for highlights.
  // The action sheet opens on long-press of a highlight tile and routes
  // into either the inline edit sheet (rename/cover/items) or the share
  // sheet (public link / native share). State is held at this level so
  // both sheets can be toggled without re-mounting the row.
  // [2026-10-18 profile-sheets] folhas com estado LOCAL, abertas por ref: abrir/fechar
  // não re-renderiza o perfil inteiro. Mesmas assinaturas dos setters antigos.
  const _hlSheetRef = useRef(null);
  const _moreSheetRef = useRef(null);
  const _nickDialogRef = useRef(null);
  const _avatarSheetRef = useRef(null);
  const setHighlightSheet = useCallback((v) => {
    if (v && v.open) _hlSheetRef.current?.open?.(v.highlight); else _hlSheetRef.current?.close?.();
  }, []);
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
  const setAvatarActionOpen = useCallback((v) => {
    if (v) _avatarSheetRef.current?.open?.(); else _avatarSheetRef.current?.close?.();
  }, []);
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
    openStoriesAt(0);
  }, [autoOpenStory, data?.stories]);
  const [editOpen, setEditOpen] = useState(false);
  const setMenuOpen = useCallback((v) => {
    if (v) _moreSheetRef.current?.open?.(); else _moreSheetRef.current?.close?.();
  }, []);
  const [reportOpen, setReportOpen] = useState(false); // [central-moderacao 2026-10-14]
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
  // Cross-platform nickname edit dialog — Alert.prompt only works on iOS,
  // so Android needs a real dialog ([2026-10-18 profile-sheets] ProfileNicknameDialog,
  // rascunho local: digitar não re-renderiza o perfil).
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
    try { require('../services/infoCache').noteInfoOpen('profile', !!cached); } catch {} // [2026-10-19 info-cache] taxa de acerto
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
          (prefetchProfile(fetchKey) || api.profileGet(fetchKey)), // [2026-10-15 profile-fast]
          new Promise((_, rej) => setTimeout(() => rej(new Error('profile_timeout')), 12000)),
        ]);
        if (cancelled) return;
        if (r?.success && r.data) {
          _cacheSet(fetchKey, r.data);
          // [2026-10-19 info-cache] mesma pessoa → "Dados do contato" também abre na hora.
          try {
            const _em = r.data?.identity?.email;
            if (_em) require('../services/infoCache').putContactInfo(_em, { identity: r.data.identity, groups: (r.data.common_chats || []).filter((c) => c && c.type === 'group') });
          } catch {}
          // só troca se mudou (revalidação igual à cópia = zero re-render/piscar)
          setData((prev) => { try { if (prev && JSON.stringify(prev) === JSON.stringify(r.data)) return prev; } catch {} return r.data; });
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
          // [2026-10-14 mention-404] profile_get responde 404 "Usuário não
          // encontrado" p/ @handle inexistente — não é erro de rede; a tela
          // dizia "Verifique sua conexão" (mentira) e oferecia retry inútil.
          const _st = Number(r?.__httpStatus) || 0;
          setErrStatus(/not authenticated/i.test(msg) ? 401
            : (_st === 404 || /n[ãa]o encontrad|not found/i.test(msg)) ? 404 : 0);
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
  // [2026-10-15 profile-fast] E-mail-alvo conhecido ANTES do profile_get quando a
  // rota ja veio por e-mail (/u/fulano@...): apelido, privacidade, destaques, live e
  // contatos em comum saem em paralelo ao profile_get em vez de em serie apos ele.
  const targetEmail = String(identity?.email || (typeof fetchKey === 'string' && fetchKey.includes('@') ? fetchKey.trim() : '')).toLowerCase();
  const _selfEmailLc = String(currentUser?.email || '').toLowerCase();

  // [2026-10-14 avatar-instant] Perfil aberto → pré-carrega a foto GRANDE
  // (size=1024, URL canônica) p/ o toque no avatar abrir já nítido.
  useEffect(() => {
    const src = identity?.email || identity?.avatar_url;
    if (!visible || !src) return undefined;
    const tm = setTimeout(() => {
      try { require('../services/avatar').prefetchAvatarFull(src, { name: identity?.name }); } catch {}
    }, 500);
    return () => clearTimeout(tm);
  }, [visible, identity?.email, identity?.avatar_url]);

  // Load saved nickname when we know which identity we're viewing.
  useEffect(() => {
    if (!targetEmail) return;
    (async () => {
      try {
        const r = await api.chatNicknameList();
        const n = r?.data?.nicknames?.[targetEmail] || '';
        setNicknameValue(n);
      } catch {}
    })();
  }, [targetEmail]);

  // Load per-contact "hide status from" preference. Endpoint returns the
  // full list of overrides for the current user; we scan for an entry
  // matching this contact + field='status'. Default = 'show'.
  useEffect(() => {
    if (!targetEmail) return;
    if (targetEmail === _selfEmailLc) return; // not applicable to self
    let cancelled = false;
    (async () => {
      try {
        const r = await api.chatPrivacyContactList?.();
        if (cancelled) return;
        const items = r?.data?.items || r?.items || [];
        const target = targetEmail;
        const match = items.find(it =>
          String(it?.contact_email || '').toLowerCase() === target &&
          String(it?.field || '') === 'status'
        );
        setHideStatusFromContact(match?.visibility === 'hide');
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [targetEmail, _selfEmailLc]);

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
    if (!targetEmail) return;
    try {
      const r = await api.statusHighlightList?.(targetEmail);
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
        let next;
        if (!Array.isArray(prev) || prev.length === 0) {
          next = normalized;
        } else {
          const backendIds = new Set(normalized.map(h => h.id));
          const pendingOptimistic = prev.filter(h =>
            !backendIds.has(h.id)
            && Array.isArray(h.status_ids) && h.status_ids.length > 0
            // Only keep optimistic adds — anything we read from backend before
            // should have been in normalized; if it's not, the backend chose
            // to hide it (true zombie) and we respect that.
            && (typeof h._optimistic === 'boolean' ? h._optimistic : true)
          );
          next = [...pendingOptimistic, ...normalized];
        }
        // [B.2] Persist to the in-memory cache so the next profile open within
        // TTL paints this strip without a skeleton or refetch flash.
        try { _highlightsCache.set(targetEmail, { list: next, ts: Date.now() }); } catch {}
        return next;
      });
    } catch {} finally {
      // [WAVE 52] Drop the skeleton once the first list resolves (success or
      // failure). Subsequent refetches keep the painted strip and only swap
      // data — never re-trigger the skeleton flash on AppState refocus.
      setHighlightsLoading(false);
    }
  }, [targetEmail]);

  // [B.2] Hydrate the strip from cache the moment identity.email is known (for
  // username-only opens where the `email` prop wasn't available at mount). Only
  // paints when local state is still empty so it never clobbers fresh data.
  useEffect(() => {
    if (!identity?.email) return;
    if (Array.isArray(highlights) && highlights.length > 0) return;
    try {
      const c = _highlightsCache.get(String(identity.email).toLowerCase());
      if (c && Array.isArray(c.list) && c.list.length > 0 && (Date.now() - c.ts) < HIGHLIGHTS_TTL_MS) {
        setHighlights(c.list);
        setHighlightsLoading(false);
      }
    } catch {}
  }, [identity?.email]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!targetEmail) { setLiveSessionId(null); return undefined; }
    let cancelled = false;
    const target = targetEmail;
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
            const startedMs = api.parseServerDate(found.started_at).getTime();
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
    // [2026-10-15 ws-live] Era poll de 20 s. live_started/live_ended chegam
    // pelo WS (lives_global) → o poll vira rede de segurança (sessão fantasma
    // sem live_ended) de 90 s, só em primeiro plano, + reconsulta ao
    // (re)autenticar o WS (eventos perdidos enquanto desconectado).
    let _stopPoll = null;
    try { _stopPoll = require('../utils/activeInterval').setActiveInterval(tick, 90000); } catch {}
    const iv = _stopPoll ? null : setInterval(tick, 90000);
    // WS instant updates — when this profile's owner goes live or ends a
    // live, flip the badge state without waiting for the poll.
    let unsubOn, unsubOff, unsubConn;
    try {
      const mailWs = require('../services/websocket').default;
      mailWs.subscribe?.('lives_global');
      unsubConn = mailWs.on?.('connection', (ev) => { if (ev && ev.status === 'authenticated') tick(); });
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
              const startedMs = api.parseServerDate(d.started_at).getTime();
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
      if (iv) clearInterval(iv);
      try { _stopPoll?.(); } catch {}
      try { unsubConn?.(); } catch {}
      try { unsubOn?.(); } catch {}
      try { unsubOff?.(); } catch {}
      try { localSub?.remove?.(); } catch {}
      try { appSub?.remove?.(); } catch {}
    };
  }, [targetEmail]);

  // "Contatos em comum" — fetched separately because not every profileGet
  // payload includes it (older backend builds). If the endpoint isn't
  // deployed yet, api.commonContacts swallows the error and returns [].
  // We hide the section unless there's at least one match OR the viewer
  // is non-self (then we show the "Em breve" placeholder for parity).
  const [commonContactsData, setCommonContactsData] = useState([]);
  useEffect(() => {
    if (!targetEmail) { setCommonContactsData([]); return undefined; }
    if (targetEmail === _selfEmailLc) { setCommonContactsData([]); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.commonContacts(targetEmail);
        if (cancelled) return;
        const items = Array.isArray(r?.items) ? r.items : [];
        setCommonContactsData(items);
      } catch {
        if (!cancelled) setCommonContactsData([]);
      }
    })();
    return () => { cancelled = true; };
  }, [targetEmail, _selfEmailLc]);

  const presence = data?.presence;
  const social = data?.social;
  const actions = data?.actions || {};
  const selfOnly = data?.self_only;
  // [2026-10-15 status-perfil] "Pela home 4 visualizações, pelo perfil 0" (founder).
  // O perfil abria um StoryViewer próprio alimentado por profile_get.stories,
  // que NÃO traz views/reações → "0 visualizações" + layout diferente. Agora o
  // MEU status aberto pelo perfil usa o MESMO viewer da home (ChatStatusTab,
  // dados do useStatuses/status_list + status_viewers), hospedado aqui numa
  // superfície invisível. Se o viewer não abrir em 4 s, cai no StoryViewer.
  const [selfStatusHost, setSelfStatusHost] = useState({ mounted: false, email: null });
  const _selfHostFallbackRef = useRef(null);
  const openStoriesAt = (startIdx = 0) => {
    const myEmail = currentUser?.email || identity?.email || '';
    if (actions?.is_self && myEmail) {
      try { if (_selfHostFallbackRef.current) clearTimeout(_selfHostFallbackRef.current); } catch {}
      setSelfStatusHost({ mounted: true, email: myEmail });
      _selfHostFallbackRef.current = setTimeout(() => {
        _selfHostFallbackRef.current = null;
        setSelfStatusHost(prev => ({ ...prev, email: null }));
        setStoryViewer({ open: true, startIdx });
      }, 4000);
      return;
    }
    setStoryViewer({ open: true, startIdx });
  };
  useEffect(() => () => { try { if (_selfHostFallbackRef.current) clearTimeout(_selfHostFallbackRef.current); } catch {} }, []);
  // [post-perfil 2026-10-20] PRÓPRIO perfil: publicações ainda subindo (fila durável) entram
  // no topo da grade na hora, com a imagem local; somem quando o profile_get já traz o id.
  const _ppMeEm = String(currentUser?.email || '').toLowerCase();
  const _ppSelfEm = (_ppMeEm && (actions?.is_self || String(fetchKey || '').toLowerCase() === _ppMeEm
    || String(identity?.email || '').toLowerCase() === _ppMeEm)) ? _ppMeEm : null;
  const _pendingPosts = usePendingProfilePosts(_ppSelfEm);
  const _serverPosts = data?.posts;
  const posts = useMemo(() => mergePendingPosts(_pendingPosts, _serverPosts || []), [_pendingPosts, _serverPosts]);
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
  // [status-rever 2026-10-14] visto/não visto vem do mesmo store da lista de conversas (status_list).
  const _profileStatusRing = useStatusRing(identity?.email || '');
  useEffect(() => {
    if (identity?.email && !_profileStatusRing) { try { primeStatusRings(); } catch {} }
  }, [identity?.email, data?.stories, _profileStatusRing]);

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

  // Posts tab shows posts + reels merged (desc by created_at). Memoized so the
  // spread+sort only re-runs when the source arrays change, not on every
  // unrelated re-render (the 20s live-poll tick + many state vars re-render
  // this component frequently). Same output as the previous inline compute.
  const combinedPosts = useMemo(() => (
    [...(posts || []), ...(reels || [])]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  ), [posts, reels]);

  // [2026-10-15 profile-virt] A grade (posts/reels/lives/midia) saiu do ScrollView
  // principal: no modo full ela e uma FlashList de linhas de 3 tiles (so as linhas
  // visiveis montam; antes a janela progressiva subia para Infinity e montava tudo).
  // Paginacao: profile_get traz no maximo 12 posts + 12 reels; ao chegar no fim da aba
  // Posts, feed_user_posts (30/pagina) completa o resto, sem duplicar ids.
  const [morePosts, setMorePosts] = useState([]);
  const morePostsRef = useRef({ key: null, page: 0, hasMore: true, loading: false });
  const [morePostsLoading, setMorePostsLoading] = useState(false);
  useEffect(() => {
    morePostsRef.current = { key: fetchKey, page: 0, hasMore: true, loading: false };
    setMorePosts([]);
  }, [fetchKey]);
  const combinedPostsAll = useMemo(() => {
    if (!morePosts.length) return combinedPosts;
    const seen = new Set(combinedPosts.map(p => String(p.id)));
    const extra = morePosts.filter(p => !seen.has(String(p.id)));
    return extra.length ? [...combinedPosts, ...extra] : combinedPosts;
  }, [combinedPosts, morePosts]);
  const _canPageMore = (posts.length >= 12 || reels.length >= 12);
  const loadMorePosts = useCallback(async () => {
    const st = morePostsRef.current;
    const em = identity?.email;
    if (!em || st.loading || !st.hasMore || st.key !== fetchKey) return;
    st.loading = true;
    setMorePostsLoading(true);
    const page = st.page + 1;
    try {
      const r = await api.feedUserPosts(em, page);
      if (morePostsRef.current !== st) return; // trocou de perfil no meio
      const list = r?.data?.posts || r?.posts || [];
      const mapped = (Array.isArray(list) ? list : []).map((q) => {
        const mu = Array.isArray(q.media_urls) ? q.media_urls : [];
        return {
          id: q.id,
          thumbnail: q.thumbnail_url || mu[0] || '',
          media_urls: mu,
          media_type: q.media_type,
          type: q.media_type,
          caption: String(q.caption || '').slice(0, 120),
          count: mu.length,
          created_at: q.created_at,
        };
      });
      st.page = page;
      st.hasMore = !!(r?.data?.has_more ?? r?.has_more) && mapped.length > 0;
      if (mapped.length) setMorePosts(prev => [...prev, ...mapped]);
    } catch {
      st.hasMore = false;
    } finally {
      st.loading = false;
      if (morePostsRef.current === st) setMorePostsLoading(false);
    }
  }, [identity?.email, fetchKey]);

  // [2026-10-15 profile-virt] Linhas da grade da aba ativa (vazia = estado vazio /
  // carregando continua no cabecalho, como antes). Definido ANTES do `body` (que o le
  // via renderTabContent) — depois dele dava TDZ no web.
  const _gridKind = (activeTab === 'posts' || activeTab === 'reels' || activeTab === 'lives' || activeTab === 'media') ? activeTab : null;
  const _isSelf = !!actions?.is_self;
  // ─── [2026-10-19 profile-native-first] Perfil NATIVO pinta JÁ ──────────
  // Antes: o perfil JS (esqueleto → cabeçalho/anéis SVG/grade) montava
  // primeiro e só depois do profile_get trocava para o ChatyyChatInfo nativo
  // (pior rota iOS no build 732: 73,5‰ de quadros lentos). Agora, com o
  // nativo disponível, a view nativa pinta no 1º render a partir da cópia
  // (cache do Perfil → infoCache do contato → semente mínima do @/e-mail) e o
  // corpo JS NÃO é montado (nem calculado); folhas/visualizadores JS montam
  // depois do 1º quadro ou quando abertos. Kill switch OTA:
  // globalThis.__chatyy_profile_native_first = false → comportamento anterior
  // (espera o profile_get com o esqueleto JS).
  const _npOn = mode === 'full' && !WEB && !!nativeProfile && !nativeProfileOff && isNativeProfileEnabled();
  const _npFirst = _npOn && _profileNativeFirstOn();
  const _npSeed = useMemo(() => {
    if (!_npFirst || identity) return null;
    return _seedProfileIdentity(fetchKey, currentUser);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_npFirst, !!identity, fetchKey, currentUser?.email]);
  const _npIdentity = identity || _npSeed;
  const _npActive = _npOn && !err && (_npFirst ? !!_npIdentity : (!loading && !!identity));
  const _npV5 = _npActive && isNativeProfileV5Enabled();
  // [perfil-fotos 2026-10-19] Galeria de fotos do perfil (Telegram): várias fotos,
  // privacidade aplicada no servidor (profile_photos). Kill: __chatyy_profile_gallery = false.
  const _ppEmail = String(identity?.email || '').toLowerCase();
  const _ppOn = ProfilePhotos.isProfileGalleryEnabled();
  const [_ppPhotos, _setPpPhotos] = useState(() => (_ppEmail ? (ProfilePhotos.getCachedProfilePhotos(_ppEmail)?.photos || null) : null));
  useEffect(() => {
    if (!_ppEmail || !_ppOn) return undefined;
    let alive = true;
    const c = ProfilePhotos.getCachedProfilePhotos(_ppEmail);
    _setPpPhotos(c ? c.photos : null); // [2026-10-19 audit] sem cache = limpa (não herda a galeria do perfil anterior)
    ProfilePhotos.fetchProfilePhotos(_ppEmail).then((r) => { if (alive && r) _setPpPhotos(r.photos); }).catch(() => {});
    const off = ProfilePhotos.subscribeProfilePhotos((ev) => { if (alive && ev && ev.email === _ppEmail) _setPpPhotos(ev.value?.photos || []); });
    return () => { alive = false; off(); };
  }, [_ppEmail, _ppOn]);
  const [_npOverlaysReady, setNpOverlaysReady] = useState(false);
  useEffect(() => {
    if (!_npActive || _npOverlaysReady) return undefined;
    let task = null;
    let tm = null;
    try {
      task = InteractionManager.runAfterInteractions(() => { tm = setTimeout(() => setNpOverlaysReady(true), 350); });
    } catch {
      tm = setTimeout(() => setNpOverlaysReady(true), 700);
    }
    return () => { try { task?.cancel?.(); } catch {} if (tm) clearTimeout(tm); };
  }, [_npActive, _npOverlaysReady]);
  const gridRows = useMemo(() => {
    if (mode !== 'full' || !_gridKind || _npActive) return _EMPTY_ROWS;
    let list = _gridKind === 'posts' ? combinedPostsAll
      : _gridKind === 'reels' ? reels
      : _gridKind === 'lives' ? lives
      : sharedMedia;
    if (!list || !list.length) return _EMPTY_ROWS;
    if (_gridKind === 'reels' && _isSelf) list = [{ __create: true }, ...list];
    const rows = [];
    for (let i = 0; i < list.length; i += 3) {
      const items = list.slice(i, i + 3);
      const k0 = items[0] && (items[0].__create ? 'c' : (items[0].session_id || items[0].id || i));
      rows.push({ key: `${_gridKind}:${k0}:${i}`, items });
    }
    return rows;
  }, [mode, _gridKind, combinedPostsAll, reels, lives, sharedMedia, _isSelf, _npActive]);

  // [2026-10-16 native-media-grid] Modo full no iOS/Android: grade NATIVA
  // (UICollectionView/RecyclerView, miniaturas c/ cache nativo, 120 Hz) com o
  // cabecalho (`body`) como filho que rola junto. Sem modulo/kill → FlashList.
  const _nativeGridOn = mode === 'full' && !WEB && !_npActive && isNativeMediaGridAvailable(); // [2026-10-19 profile-native-first] perfil nativo não calcula a grade da rota ?grid=1
  const _sharedMediaKey = (data?.shared_media || _EMPTY_ROWS);
  const nativeGrid = useMemo(() => {
    if (!_nativeGridOn || !_gridKind) return _EMPTY_NATIVE_GRID;
    const list = _gridKind === 'posts' ? combinedPostsAll
      : _gridKind === 'reels' ? reels
      : _gridKind === 'lives' ? lives
      : _sharedMediaKey;
    const items = [];
    const byKey = new Map();
    if (_gridKind === 'reels' && _isSelf && list && list.length) {
      const v = t?.('videoStudio.create');
      items.push({ k: '__create', create: true, cl: v && v !== 'videoStudio.create' ? v : 'Criar' });
    }
    for (const it of (list || [])) {
      if (!it) continue;
      const tile = _toNativeTile(it, _gridKind, t);
      if (byKey.has(tile.k)) continue;
      byKey.set(tile.k, it);
      items.push(tile);
    }
    return { items, byKey, kind: _gridKind };
  }, [_nativeGridOn, _gridKind, combinedPostsAll, reels, lives, _sharedMediaKey, _isSelf, t]);

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
    const wasFollowing = !!social?.is_following;
    const prevCount = Number(social?.followers_count) || 0; // guard NaN
    // Optimistic UI update so the tap feels instant (count guarded with `|| 0`
    // so an undefined followers_count never produces NaN).
    setData(prev => prev ? { ...prev, social: { ...prev.social,
      is_following: !wasFollowing,
      followers_count: prevCount + (wasFollowing ? -1 : 1),
    } } : prev);
    try {
      const r = wasFollowing
        ? await api.unfollowUser?.(identity.email)
        : await api.followUser?.(identity.email);
      if (r?.success === false) throw new Error('follow_failed');
      // Merge the server's authoritative counts/flags so the optimistic guess
      // self-corrects instead of drifting over repeated toggles. Previously
      // the return value was ignored entirely.
      const srv = r?.data || r || {};
      if (srv && (srv.followers_count != null || srv.is_following != null || srv.follows_me != null)) {
        setData(prev => prev ? { ...prev, social: { ...prev.social,
          is_following: srv.is_following != null ? !!srv.is_following : prev.social?.is_following,
          followers_count: srv.followers_count != null ? (Number(srv.followers_count) || 0) : (prev.social?.followers_count || 0),
          follows_me: srv.follows_me != null ? !!srv.follows_me : prev.social?.follows_me,
        } } : prev);
      }
    } catch {
      // Revert to the pre-tap follow state on failure.
      setData(prev => prev ? { ...prev, social: { ...prev.social,
        is_following: wasFollowing,
        followers_count: prevCount,
      } } : prev);
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
    if (item.__pending && openPendingPostMenu(item)) return; // [post-perfil 2026-10-20]
    // Shared chat media — open inside the conversation
    if (!item.id && item.conversation_id && router) {
      if (mode === 'peek') onClose?.();
      require('../services/openConversation').openConversation(`/chat-conversation?id=${item.conversation_id}`);
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
      openStoriesAt(startIdx);
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
                backgroundColor: colors?.text || '#111111', // [2026-10-13 visual] anel visível no escuro
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
                      flex: 1, borderRadius: 30, backgroundColor: s.bg_color || colors?.primary || '#111111',
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

  // [central-moderacao 2026-10-14] Antes enviava 'profile_report' em silêncio (sem motivo nem retorno).
  // Agora abre a folha de denúncia com motivos padronizados → fila única da moderação.
  const handleReport = useCallback(() => {
    if (!identity?.email) return;
    setMenuOpen(false);
    setReportOpen(true);
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
  // [2026-10-19 profile-grid-native] abrir destaque = função do componente:
  // a faixa JS e a faixa NATIVA (ChatInfo api 5) chamam a mesma.
  // [feat-10] Tap → resolve items via status_highlight_items + open
  // the existing StoryViewer.
  const openHighlight = async (h) => {
    if (!h || h.id == null) return;
    const isSelf = !!actions?.is_self;
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
      Alert.alert(t?.('common.error') || 'Erro', e?.message || t?.('common.failed') || 'Falhou');
    }
  };

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
    // [B.2] "+" add tile lives in ListHeaderComponent so the windowed FlatList
    // below only virtualizes the real highlight tiles.
    const renderAddTile = () => (
      isSelf ? (
          <TouchableOpacity
            activeOpacity={0.8}
            style={{ alignItems: 'center', width: SIZE + 8, marginRight: 16 }}
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
                  mediaTypes: ['images'],
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
                    // [2026-05-30] highlight_only:true — Destaques são coleções
                    // PERMANENTES no perfil (modelo Instagram), separadas do
                    // status efêmero de 24h. Antes este publish criava um STATUS
                    // real que aparecia no feed de stories por 24h (reclamação do
                    // founder: "destaque vai pro status"). Agora o backend insere
                    // a linha já arquivada — referenciável pelo destaque mas
                    // invisível no status_list/manifest. Reproduz na adição de
                    // status existentes ao destaque (abaixo) também.
                    const pub = await api.statusPublish(url, 'image', '#111111', null, { highlight_only: true });
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
                Alert.alert(t?.('common.error') || 'Erro', e?.message || t?.('common.failed') || 'Falhou');
              }
            }}
          >
            <View style={{
              width: RING, height: RING, borderRadius: RING / 2,
              // Dashed hairline ring reads as an inviting "add a highlight"
              // affordance (premium/empty-slot grammar) instead of a solid
              // grey circle. Soft neutral fill keeps it airy; the plus sits
              // centered so the tile aligns perfectly with the covers beside it.
              borderWidth: 1.5, borderStyle: 'dashed',
              borderColor: isDark ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.22)',
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.035)',
            }}>
              <IconPlus size={26} color={isDark ? '#F1F3F5' : '#111111'} strokeWidth={2.2} />
            </View>
            <Text style={{ fontSize: 12, color: colors?.textSecondary || colors?.text, marginTop: 7, fontWeight: '600', letterSpacing: 0.1 }} numberOfLines={1}>
              {t?.('profile.newHighlight') || 'Novo'}
            </Text>
          </TouchableOpacity>
      ) : null
    );
    // [B.2] Per-tile renderer for the windowed FlatList below.
    const renderHighlightTile = (h) => {
          const cover = h.cover_url ? resolveMedia(h.cover_url) : null;
          // [2026-10-19 profile-rings] Anel do destaque SEM SVG (era um <Svg> +
          // LinearGradient por ladrilho → 1 superfície de desenho por destaque).
          // Agora é a própria borda da View: metade de cima/esquerda na cor do
          // texto e de baixo/direita laranja (mesma diagonal #111 → #F97316 do
          // degradê antigo) — zero camada extra, desenhado pelo nativo.
          const ringBase = colors?.text || '#111111';
          // [feat-10] Tap → resolve items via status_highlight_items + open
          // the existing StoryViewer. Long-press (self) → delete with
          // confirmation. Mirrors Instagram's interaction grammar.
          const openHighlightTile = () => openHighlight(h);
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
              // [2026-10-18 polish2] helper central (mesma intensidade de long-press do app).
              require('../services/haptics').hapticEvent('longPress');
            } catch {}
            setHighlightSheet({ open: true, highlight: { id: h.id, title: h.title, cover_url: h.cover_url, isSelf } });
          };
          return (
            <TouchableOpacity
              key={h.id}
              activeOpacity={0.85}
              style={{ alignItems: 'center', width: SIZE + 8 }}
              onPress={openHighlightTile}
              onLongPress={openActionSheet}
              delayLongPress={350}
              accessibilityLabel={(t?.('profile.openHighlight') || 'Abrir destaque') + ' ' + (h.title || '')}
            >
              <View style={{
                width: RING, height: RING, borderRadius: RING / 2,
                alignItems: 'center', justifyContent: 'center',
                padding: 2,
                borderWidth: 2,
                borderTopColor: ringBase,
                borderLeftColor: ringBase,
                borderRightColor: '#F97316',
                borderBottomColor: '#F97316',
                backgroundColor: tone,
              }}>
                {cover ? (
                  WEB
                    ? <img src={cover} alt="" style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2, objectFit: 'cover' }} />
                    : (_ExpoImage
                        ? <_ExpoImage source={{ uri: cover }} style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2 }} contentFit="cover" cachePolicy="memory-disk" />
                        : <Image source={{ uri: cover }} style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2 }} resizeMode="cover" />)
                ) : (
                  <View style={{ width: SIZE - 4, height: SIZE - 4, borderRadius: (SIZE - 4) / 2, backgroundColor: '#11111122' }} />
                )}
              </View>
              <Text style={{ fontSize: 12, color: colors?.text, marginTop: 7, fontWeight: '600', maxWidth: SIZE + 8, letterSpacing: 0.1 }} numberOfLines={1}>
                {h.title || ''}
              </Text>
            </TouchableOpacity>
          );
    };
    // [B.2] Windowed horizontal FlatList — virtualizes the destaques strip so a
    // profile with 50+ highlights doesn't render every tile up front (IG-grade
    // smoothness on mid-tier Android). removeClippedSubviews + small batch.
    return (
      <FlatList
        data={highlights}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(h) => String(h.id)}
        ListHeaderComponent={renderAddTile}
        renderItem={({ item }) => renderHighlightTile(item)}
        removeClippedSubviews
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 6 }}
        ItemSeparatorComponent={() => <View style={{ width: 16 }} />}
      />
    );
  };

  const renderHeader = () => {
    if (!identity) return null;
    const postsTotal = (posts.length || 0) + (reels.length || 0);
    // [capa-2026-10-19] host antigo chatyy.com.br/profile-covers (404) → media; relativo → absoluto.
    // Capa que não carrega (objeto apagado) some em vez de virar retângulo cinza.
    const _coverRaw = normalizeCoverUrl(identity.cover_url || '', BASE_URL);
    const coverUrl = _coverRaw && _coverRaw !== coverFailedUrl ? _coverRaw : '';
    const accountType = identity.account_type || 'personal';
    return (
      <View>
        {/* Cover photo banner — full-width 3:1 strip, sits above the avatar
            Instagram-style (no overlap; the avatar lands below in normal
            header flow). Hidden when the user hasn't set one yet to avoid
            an empty grey rectangle. Profile-upgrade combo (2026-05-18). */}
        {coverUrl ? (
          <View style={{
            width: '100%', height: 128, backgroundColor: colors?.surfaceVariant || 'rgba(17, 17, 17,0.05)',
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors?.border || (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'),
            overflow: 'hidden',
          }}>
            {_ExpoImage ? (
              <_ExpoImage source={{ uri: coverUrl }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" transition={180} onError={() => setCoverFailedUrl(coverUrl)} />
            ) : (
              <Image source={{ uri: coverUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" onError={() => setCoverFailedUrl(coverUrl)} />
            )}
            {/* Bottom scrim so the @handle + avatar that follow never lose
                contrast against a bright cover. Web uses a real CSS gradient;
                native falls back to a soft translucent wash. Purely cosmetic —
                pointerEvents none so it never eats taps. */}
            {WEB ? (
              <View pointerEvents="none" style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%',
                backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0), ${isDark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.22)'})`,
              }} />
            ) : (_Svg && _SvgDefs && _SvgLinearGradient && _SvgStop && _SvgRect) ? (
              // [capa-2026-10-19] degradê real (transparente → escuro) no nativo,
              // igual à web — o texto/ícones sobre/abaixo da capa ficam legíveis.
              <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' }}>
                <_Svg width="100%" height="100%" preserveAspectRatio="none">
                  <_SvgDefs>
                    <_SvgLinearGradient id="coverScrim" x1="0" y1="0" x2="0" y2="1">
                      <_SvgStop offset="0" stopColor="#000" stopOpacity="0" />
                      <_SvgStop offset="1" stopColor="#000" stopOpacity={isDark ? 0.5 : 0.28} />
                    </_SvgLinearGradient>
                  </_SvgDefs>
                  <_SvgRect x="0" y="0" width="100%" height="100%" fill="url(#coverScrim)" />
                </_Svg>
              </View>
            ) : (
              <View pointerEvents="none" style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, height: '45%',
                backgroundColor: isDark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.14)',
              }} />
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
              <View style={{
                width: 20, height: 20, borderRadius: 10, backgroundColor: '#1DA1F2',
                alignItems: 'center', justifyContent: 'center',
                // Hairline white ring lifts the badge off the @handle line so
                // it reads as a stamped verification mark (Instagram/X parity).
                borderWidth: 1.5, borderColor: isDark ? 'rgba(13,13,13,0.9)' : '#fff',
                ...(Platform.OS === 'web' ? { boxShadow: '0 1px 4px rgba(29,161,242,0.45)' } : {
                  shadowColor: '#1DA1F2', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2,
                }),
              }}>
                <IconCheck size={11} color="#fff" strokeWidth={3} />
              </View>
            )}
            {/* Lock icon for private accounts — Instagram parity */}
            {identity.is_private && (
              <IconLock size={16} color={colors?.text} />
            )}
            {/* Account type chip — Creator (palette/brush SVG) / Business
                (briefcase SVG). Personal renders nothing so most users see a
                clean header. NO emoji: icons come from the shared SVG set so
                they inherit crisp rendering + color on every density. Chip is
                a soft-tinted pill with a hairline border so it reads as a
                "badge" without shouting over the @handle next to it. */}
            {accountType === 'creator' && (
              <View style={{
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
                backgroundColor: colors?.surfaceVariant || 'rgba(17, 17, 17,0.08)',
                borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border || 'rgba(17, 17, 17,0.18)',
                flexDirection: 'row', alignItems: 'center', gap: 4,
              }} accessibilityLabel={t?.('profile.accountTypeCreator') || 'Criador'}>
                <IconBrush size={11} color={colors?.text} />
                <Text style={{ fontSize: 11, color: colors?.text, fontWeight: '600', letterSpacing: 0.1 }}>
                  {t?.('profile.accountTypeCreator') || 'Criador'}
                </Text>
              </View>
            )}
            {accountType === 'business' && (
              <View style={{
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
                // [2026-10-13 visual] marca P&B — chip neutro igual ao "Criador".
                backgroundColor: colors?.surfaceVariant || 'rgba(17, 17, 17,0.08)',
                borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border || 'rgba(17, 17, 17,0.18)',
                flexDirection: 'row', alignItems: 'center', gap: 4,
              }} accessibilityLabel={t?.('profile.accountTypeBusiness') || 'Negócio'}>
                <IconBriefcase size={11} color={colors?.text} />
                <Text style={{ fontSize: 11, color: colors?.text, fontWeight: '600', letterSpacing: 0.1 }}>
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
            <TouchableOpacity onPress={() => (onOpenSettings ? onOpenSettings() : (router?.push ? router.push('/settings') : setSettingsOpen(true)))} style={{ padding: 6 }} accessibilityLabel={t?.('settings.title') || 'Configurações'} testID="profile-open-settings">
              {/* [2026-10-11 settings-unify] engrenagem → hub único /settings */}
              <IconSettings size={23} color={colors?.text} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => setMenuOpen(true)} style={{ padding: 6 }} accessibilityLabel={t?.('a11y.moreOptions') || 'Mais opções'}>
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
            // "MUCH LESS BLACK" 2026: no heavy black ring on the avatar. When
            // there are no stories the avatar sits inside a barely-there light
            // hairline (colors.border) — WhatsApp/iOS clean, avatar prominent.
            const haloColor = colors?.border || (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)');
            // [2026-10-19 profile-rings] halo = borda fina da própria View (era <Svg><Circle>).
            const renderHalo = () => (
              <View pointerEvents="none" style={{
                position: 'absolute', top: 0, left: 0,
                width: HALO_SIZE, height: HALO_SIZE, borderRadius: HALO_SIZE / 2,
                borderWidth: 1.5, borderColor: haloColor,
              }} />
            );
            const isLive = !!liveSessionId;
            const liveLabel = (t?.('live.aoVivo') || 'AO VIVO').toUpperCase();
            const inner = hasStories ? (
              <StoryRingAvatar
                name={identity.name}
                email={identity.email}
                size={AVATAR_SIZE}
                // [status-rever 2026-10-14] segmentado por status (WhatsApp); cinza quando já visto — continua tocável p/ ver de novo
                ringStyle={!actions?.is_self && _profileStatusRing?.count > 1 ? 'segmented' : 'solid'}
                segments={_profileStatusRing?.count || 1}
                itemsViewed={!actions?.is_self ? (_profileStatusRing?.viewed || null) : null}
                allViewed={!actions?.is_self && !!_profileStatusRing?.allViewed}
                isDark={isDark}
                colors={colors}
                isLive={isLive}
                liveLabel={liveLabel}
              />
            ) : (
              <View style={{
                width: HALO_SIZE, height: HALO_SIZE,
                // [2026-10-10 settings-polish] sem raio o boxShadow (web) desenhava
                // um QUADRADO com sombra atrás do avatar redondo.
                borderRadius: HALO_SIZE / 2,
                alignItems: 'center', justifyContent: 'center',
                // Soft depth so the avatar reads as a lifted, premium focal
                // point instead of sitting flat on the background. Purely
                // cosmetic — kept subtle so it never looks like a heavy halo.
                ...(isDark ? {} : Platform.OS === 'web'
                  ? { boxShadow: '0 4px 16px rgba(15,23,42,0.12)' }
                  : {
                      shadowColor: '#000',
                      shadowOpacity: isDark ? 0.35 : 0.14,
                      shadowRadius: 10,
                      shadowOffset: { width: 0, height: 4 },
                      elevation: 4,
                    }),
              }}>
                {/* [2026-10-14] escuro: sem anel (lia como moldura cinza estranha) */}
                {!isLive && !isDark && renderHalo()}
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
                onPress={() => openStoriesAt(0)}
                onLongPress={actions?.is_self ? () => setAvatarActionOpen(true) : undefined}
                delayLongPress={350}
                activeOpacity={0.85}
                accessibilityLabel={t?.('profile.viewStories') || 'Ver status'}
              >{inner}</TouchableOpacity>
            );
          })()}
          {/* Instagram pattern: 3-column stats row to the right of the avatar.
              Each Stat is a flex:1 column; hairline vertical dividers between
              them give the "stats card" rhythm Instagram uses, keeping the
              numbers visually grouped without a heavy bordered box. */}
          {(() => {
            // [2026-10-10 settings-polish] sem divisores verticais (Instagram).
            return (
              <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 4 }}>
                <Stat value={postsTotal} label={t?.('profile.posts') || 'Publicações'} colors={colors} />
                <Stat value={social?.followers_count || 0} label={t?.('profile.followers') || 'Seguidores'} colors={colors}
                  onPress={() => (onOpenFollowers ? onOpenFollowers(identity.email, 'followers') : setFollowersTab('followers'))} />
                <Stat value={social?.following_count || 0} label={t?.('profile.following') || 'Seguindo'} colors={colors}
                  onPress={() => (onOpenFollowers ? onOpenFollowers(identity.email, 'following') : setFollowersTab('following'))} />
              </View>
            );
          })()}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 }}>
              <IconLink size={13} color={colors.primary} />
              <Text style={{ fontSize: 13, color: colors.primary, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
                {identity.website}
              </Text>
            </View>
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
                      paddingHorizontal: 13, paddingVertical: 7,
                      borderRadius: 999, // pill — matches the action-button family
                      // [2026-10-13 visual] no escuro o tom rgba(17,17,17) sumia no #000
                      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17, 17, 17,0.06)',
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17, 17, 17,0.14)',
                    }}
                    accessibilityRole="link"
                    accessibilityLabel={label}
                  >
                    <IconLink size={13} color={isDark ? '#F1F3F5' : '#111111'} />
                    <Text
                      numberOfLines={1}
                      style={{ fontSize: 13, color: isDark ? '#F1F3F5' : '#111111', fontWeight: '600', maxWidth: 180 }}
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
                label={social?.is_following
                  ? (t?.('profile.following') || 'Seguindo')
                  : (social?.follows_me
                      ? (t?.('profile.followBack') || 'Seguir de volta')
                      : (t?.('profile.follow') || 'Seguir'))}
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
        {/* [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
            "Enviar diamante" chip on non-self profiles. SendDiamondSheet
            component itself stays in the tree so flipping the flag back
            restores the chip with one line. */}
        {DIAMONDS_ENABLED && !actions.is_self && identity?.email ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            <TouchableOpacity
              onPress={() => setSendDiamondOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t?.('gifts.sendGift') || 'Enviar presente'}
              style={{
                flex: 1,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                minHeight: 44,
                backgroundColor: 'transparent',
                borderWidth: 1,
                borderColor: colors?.border || (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'),
              }}
            >
              <IconGiftBox size={18} color={colors?.text || '#111111'} />
              <Text style={{ color: colors?.text || '#111111', fontSize: 14, fontWeight: '700' }}>
                {t?.('gifts.sendGift') || 'Enviar presente'}
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
          <View>
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
            {/* [2026-10-18 settings-sub-native] Carteira saiu do perfil: mora em Configurações (sem duplicar). */}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 7 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 }}>
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
            <View style={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 7 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 }}>
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
            <View style={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 7 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {t?.('profile.commonChats') || 'Grupos em comum'}
              </Text>
            </View>
            <View style={{
              marginHorizontal: 12, borderRadius: 14, overflow: 'hidden',
              borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
              backgroundColor: colors?.surface,
            }}>
              {commonChats.slice(0, 5).map((c, i, arr) => (
                <TouchableOpacity key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8, minHeight: 50, borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors?.border }} activeOpacity={0.7}
                  onPress={() => { require('../services/openConversation').openConversation(`/chat-conversation?id=${c.id}`); onClose?.(); }}>
                  <AvatarCircle name={c.name} size={36} />
                  <Text style={{ flex: 1, fontSize: 15, color: colors?.text, fontWeight: '500' }} numberOfLines={1}>{c.name}</Text>
                  <IconChevronRight size={18} color={colors?.textTertiary} />
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Common contacts (mutual address book) */}
        {!actions.is_self && (
          <>
            <View style={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 7, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 }}>
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
              <View style={{ marginHorizontal: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border, backgroundColor: colors?.surface, paddingHorizontal: 14, paddingVertical: 12 }}>
                <Text style={{ fontSize: 13, color: colors?.textTertiary, fontStyle: 'italic' }}>
                  {t?.('common.comingSoon') || 'Em breve'}
                </Text>
              </View>
            ) : (
              <View style={{
                marginHorizontal: 12, borderRadius: 14, overflow: 'hidden',
                borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
                backgroundColor: colors?.surface,
              }}>
                {commonContactsData.slice(0, 5).map((c, i, arr) => (
                  <TouchableOpacity
                    key={c.email || c.id}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8, minHeight: 50, borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors?.border }}
                    activeOpacity={0.7}
                    onPress={() => {
                      if (!c.email) return;
                      if (mode === 'peek') onClose?.();
                      router?.push(`/u/${encodeURIComponent(c.email)}`);
                    }}
                  >
                    <AvatarCircle name={c.name || c.email} email={c.email} size={36} />
                    <Text style={{ flex: 1, fontSize: 15, color: colors?.text, fontWeight: '500' }} numberOfLines={1}>{c.name || c.email}</Text>
                    <IconChevronRight size={18} color={colors?.textTertiary} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}

        {/* See full profile */}
        <TouchableOpacity
          onPress={handleOpenFullFromPeek}
          activeOpacity={0.85}
          style={{ marginTop: 16, marginHorizontal: 12, paddingVertical: 13, borderRadius: 12, backgroundColor: colors?.primary || '#111111', alignItems: 'center' }}
        >
          <Text style={{ fontSize: 14, fontWeight: '700', color: colors?.onPrimary || '#fff' }}>
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
      // "Conversas" tab removed — it duplicated the "Mensagem" action button
      // (both opened a chat with this user). Groups in common still surface via
      // the "Grupos em comum" section above.
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
      // [2026-10-15 profile-virt] Grade com itens = linhas da FlashList (fora do cabecalho).
      if (gridRows.length > 0) return null;
      if (activeTab === 'posts') {
        // User reportou: stat "Posts" mostra 2 mas a tab vinha vazia. Razão:
        // postsTotal = posts.length + reels.length, então quando o user só
        // tem reels, o contador era 2 mas o array `posts` vinha [].
        // Tab Posts agora mostra posts E reels combinados (ordenados desc),
        // assim o conteúdo aparece. Tab Reels segue só com reels.
        const combined = combinedPosts;
        if (combined.length === 0) {
          return (
            <ScreenEmptyState
              compact
              kind="photos"
              style={{ paddingVertical: 40 }}
              title={actions.is_self
                ? _ti('profile.empty.postsSelfTitle', 'Sem publicações ainda')
                : _ti('profile.empty.postsOtherTitle', 'Nenhuma publicação')}
              subtitle={actions.is_self
                ? _ti('profile.empty.postsSelfSub', 'Compartilhe sua primeira foto ou Reel.')
                : _ti('profile.empty.postsOtherSub', 'Quando publicar, vai aparecer aqui.')}
              cta={actions.is_self ? { label: _ti('profile.empty.postsCta', 'Criar publicação'), onPress: () => { // [post-perfil 2026-10-20] compositor novo (fila durável); kill → antigo
                if (_ppPostsOn && require('../services/profilePostQueue').isProfilePostQueueEnabled()) _ppPublish(); else router?.push('/spotlight?createPost=1');
              } } : undefined}
            />
          );
        }
        return null;
      }
      if (activeTab === 'reels') {
        if (!reels.length) {
          return (
            <ScreenEmptyState
              compact
              kind="reels"
              style={{ paddingVertical: 40 }}
              title={actions.is_self
                ? _ti('profile.empty.reelsSelfTitle', 'Nenhum Reel ainda')
                : _ti('profile.empty.reelsOtherTitle', 'Nenhum Reel')}
              subtitle={actions.is_self
                ? _ti('profile.empty.reelsSelfSub', 'Grave seu primeiro vídeo curto.')
                : _ti('profile.empty.reelsOtherSub', 'Os Reels aparecem aqui quando publicados.')}
              cta={actions.is_self ? { label: _ti('profile.empty.reelsCta', 'Gravar Reel'), onPress: () => router?.push('/video-studio/camera') /* [2026-10-13 video-studio] */ } : undefined}
            />
          );
        }
        return null;
      }
      if (activeTab === 'lives') {
        // Initial fetch in flight — show a brief activity indicator instead
        // of jumping straight to the empty state (would feel like the user's
        // lives "disappeared" between tab presses).
        if (livesLoading && lives.length === 0) {
          // [2026-10-16 polish-perfil] skeleton de grade (mesmo desenho da
          // grade real) no lugar do spinner solto.
          return (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 2, paddingTop: 2 }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <Shimmer key={i} delay={i * 40} style={{ width: '33%', aspectRatio: 0.8, borderRadius: 2 }} />
              ))}
            </View>
          );
        }
        if (lives.length === 0) {
          return (
            <ScreenEmptyState
              compact
              kind="lives"
              style={{ paddingVertical: 40 }}
              title={actions.is_self
                ? _ti('profile.empty.livesSelfTitle', 'Sem lives salvos ainda')
                : _ti('profile.empty.livesOtherTitle', 'Sem lives salvos')}
              subtitle={actions.is_self
                ? _ti('profile.empty.livesSelfSub', 'Suas transmissões salvas vão aparecer aqui.')
                : _ti('profile.empty.livesOtherSub', 'Quando esse usuário salvar uma live, vai aparecer aqui.')}
              cta={actions.is_self ? { label: _ti('profile.empty.livesCta', 'Iniciar live'), onPress: () => router?.push('/live-broadcast') } : undefined}
            />
          );
        }
        return null;
      }
      if (activeTab === 'media') return null;
      if (activeTab === 'email') {
        return (
          <View style={{
            marginHorizontal: 12, marginTop: 10,
            borderRadius: 14, overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
            backgroundColor: colors?.surface,
          }}>
            {emailPreview.map((e, idx) => (
              <TouchableOpacity
                key={`${e.folder}:${e.uid}:${idx}`}
                onPress={() => router?.push(`/read?uid=${e.uid}&folder=${encodeURIComponent(e.folder)}`)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 50, borderBottomWidth: idx < emailPreview.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors?.border }}
                activeOpacity={0.6}
              >
                <View style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: e.from_me ? (colors?.surfaceVariant || '#11111211') : (colors?.surfaceVariant || '#f3f4f6'),
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconMail size={14} color={colors?.text || '#111'} />
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

  // [2026-10-19 profile-native-first] nativo ativo → o corpo JS (cabeçalho,
  // destaques, abas, grade) nem é construído.
  const body = (mode === 'full' && _npActive) ? null : loading ? (
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
          : errStatus === 404
            ? <IconUser size={32} color={colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)')} />
            : <IconAlertTriangle size={32} color={isDark ? '#fca5a5' : '#dc2626'} />}
      </View>
      <Text style={{ color: colors?.text, fontSize: 18, fontWeight: '700', marginBottom: 6, textAlign: 'center' }}>
        {errStatus === 401
          ? (t?.('profile.errSessionTitle') || 'Sessão expirada')
          : errStatus === 404
            ? (t?.('profile.notFoundTitle') || 'Usuário não encontrado')
            : (t?.('profile.errLoadTitle') || 'Não foi possível carregar')}
      </Text>
      <Text style={{ color: colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)'), fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 24 }}>
        {errStatus === 401
          ? (t?.('profile.errSessionMsg') || 'Sua sessão expirou. Faça login de novo pra ver o perfil.')
          : errStatus === 404
            ? (() => { const _h = String(fetchKey || '').replace(/^@/, ''); const _fb = `@${_h} não existe no Chatyy`; const _v = t?.('profile.notFoundMsg', { handle: _h }); return (_v && _v !== 'profile.notFoundMsg') ? _v : _fb; })()
            : (t?.('profile.errLoadMsg') || 'Verifique sua conexão e tente novamente.')}
      </Text>
      {errStatus === 404 ? (
        <TouchableOpacity
          onPress={() => {
            try {
              if (mode === 'peek' && onClose) { onClose(); return; }
              if (router?.canGoBack?.()) router.back(); else router?.replace?.('/chat');
            } catch {}
          }}
          style={{
            paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12, minHeight: 44, justifyContent: 'center',
            backgroundColor: colors?.primary || '#111111',
          }}
          accessibilityRole="button"
        >
          <Text style={{ color: colors?.onPrimary || '#fff', fontWeight: '700', fontSize: 14 }}>
            {t?.('common.back') || 'Voltar'}
          </Text>
        </TouchableOpacity>
      ) : (
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity
          onPress={() => { require('../utils/userRetry').noteUserRetry(); setErr(null); setErrStatus(0); setLoading(true); setRetryCounter(c => c + 1); }}
          style={{
            paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12, minHeight: 44, justifyContent: 'center',
            backgroundColor: colors?.primary || '#111111',
          }}
          accessibilityRole="button"
        >
          <Text style={{ color: colors?.onPrimary || '#fff', fontWeight: '700', fontSize: 14 }}>
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
      )}
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
      onDeleted={(deletedId) => setData(d => (d ? {
        ...d,
        posts: (d.posts || []).filter(p => p.id !== deletedId),
        reels: (d.reels || []).filter(p => p.id !== deletedId),
        shared_media: (d.shared_media || []).filter(p => p.id !== deletedId),
      } : d))}
    />
  );

  // WAVE 95 (2026-05-21) — Tap-to-fullscreen avatar lightbox for OTHER
  // users. Was: empty StoryViewer (black screen) which never showed the
  // actual photo. Now: full-resolution profile photo with pinch-zoom,
  // swipe-down to dismiss, WhatsApp/Telegram parity.
  const avatarLightboxNode = (
    <AvatarLightbox
      visible={avatarLightboxOpen}
      email={lightboxUri ? null : (identity?.email || null)}
      uri={lightboxUri || identity?.avatar_url || null}
      name={identity?.name || identity?.username || identity?.email || ''}
      onClose={() => { setAvatarLightboxOpen(false); setLightboxUri(null); }}
    />
  );

  // Inline story viewer — opened from the highlights row at the top of the
  // profile. Replaces the old /chat?tab=status&viewStory=... deep-link that
  // chat.js never consumed (hence the white screen the user hit).
  // [2026-10-15 status-perfil] Host do viewer canônico (mesmo da home). Superfície
  // 0×0 fora da tela (Fabric não faz layout sob display:none — ver chat.js
  // _STATUS_SURFACE_HIDDEN); fica montado após o 1º uso p/ o "+"/câmera/menu.
  let selfStatusHostNode = null;
  if (selfStatusHost.mounted) {
    let _CST = null;
    try { _CST = require('./ChatStatusTab').default; } catch {}
    if (_CST) {
      selfStatusHostNode = (
        <View
          style={Platform.OS === 'web' ? { display: 'none' } : { position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'hidden', opacity: 0 }}
          pointerEvents="box-none"
        >
          <_CST
            embedded
            colors={colors}
            isDark={isDark}
            t={t}
            user={currentUser}
            router={router}
            openStatusEmail={selfStatusHost.email}
            onOpenStatusConsumed={() => setSelfStatusHost(prev => (prev.email ? { ...prev, email: null } : prev))}
            onViewerVisibleChange={(vis) => {
              if (!vis) return;
              try { if (_selfHostFallbackRef.current) clearTimeout(_selfHostFallbackRef.current); } catch {}
              _selfHostFallbackRef.current = null;
              // abriu tarde (dados chegaram após o fallback) → fecha o StoryViewer reserva.
              setStoryViewer(prev => (prev.open ? { open: false, startIdx: 0 } : prev));
            }}
          />
        </View>
      );
    }
  }

  const storyViewerNode = (
    <StoryViewer
      visible={storyViewer.open}
      stories={stories}
      startIdx={storyViewer.startIdx}
      ownerName={identity?.name || ''}
      ownerEmail={identity?.email || ''}
      onClose={() => setStoryViewer({ open: false, startIdx: 0 })}
      isSelf={!!actions?.is_self}
      // [2026-10-21 status-perfil] visto pelo perfil → store de anéis + instâncias do useStatuses
      onMarkViewed={!actions?.is_self ? (id) => {
        try { require('./status/statusRingStore').markRingOwnerViewed(identity?.email || '', id, (stories || []).map(s => s?.id)); } catch {}
        try { require('../hooks/useStatuses').broadcastStatusViewed(id); } catch {}
      } : undefined}
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
            const statusType = a.type === 'video' ? 'video' : 'image';
            // Long video → split into ≤30s back-to-back status segments (WhatsApp).
            // Single-element array for photos / short clips = unchanged flow.
            let parts = [file];
            if (a.type === 'video') {
              try {
                const { segmentVideoForStatus } = require('../services/statusVideoSegments');
                parts = await segmentVideoForStatus(file);
              } catch { parts = [file]; }
            }
            for (const part of parts) {
              const uploadR = await api.statusUpload?.(part);
              if (uploadR?.success && uploadR.data?.url) {
                await api.statusPublish?.(uploadR.data.url, statusType, '#000000', null, {});
              }
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
      // [2026-05-28 Lester QA] Trash icon in highlight viewer was wiring
      // nothing — StoryViewer fires onDelete?.(id) but no handler was passed,
      // so tapping the trash silently did nothing. Now removes the item
      // from this highlight (Instagram-style: photo leaves the destaque,
      // original status untouched), updates the viewer's local state, and
      // auto-closes/prunes the highlight tile when it becomes empty.
      onDelete={async (statusId) => {
        if (!statusId || !highlightViewer.highlightId) return;
        try { await api.statusHighlightRemoveStatus?.(highlightViewer.highlightId, statusId); } catch {}
        // Drop the item locally; if the user just removed the last one,
        // close the viewer AND remove the now-empty destaque from the row.
        const nextItems = (highlightViewer.items || []).filter(x => Number(x.id) !== Number(statusId));
        if (nextItems.length === 0) {
          const hid = highlightViewer.highlightId;
          setHighlightViewer({ open: false, items: [], title: '', startIdx: 0, highlightId: null });
          setHighlights(prev => prev.filter(x => Number(x.id) !== Number(hid)));
          try { await api.statusHighlightDelete?.(hid); } catch {}
        } else {
          // Reset startIdx if we removed the last visible story so the
          // viewer doesn't read past the new end.
          setHighlightViewer(prev => ({
            ...prev,
            items: nextItems,
            startIdx: Math.min(prev.startIdx || 0, nextItems.length - 1),
          }));
        }
      }}
      onMentionPress={({ email, username }) => {
        const target = email || username;
        if (!target) return;
        setHighlightViewer({ open: false, items: [], title: '', startIdx: 0, highlightId: null });
        setTimeout(() => { try { router?.push?.(`/u/${encodeURIComponent(target)}`); } catch {} }, 150);
      }}
    />
  );

  // ── [2026-10-18 profile-sheets] ações das folhas (rodam DEPOIS que a folha fechou;
  // no nativo, depois que o sheet do sistema desceu — runAfterNativeSheet na folha).
  const _profSheetsNative = profileNativeSheetsOn(mode);
  // (50 ms como antes: no Modal JS o iOS precisa que a folha saia antes do próximo Modal)
  const _onHighlightEdit = useCallback((h) => { setTimeout(() => setHighlightEdit({ open: true, highlight: h }), 50); }, []);
  const _onHighlightShare = useCallback((h) => { setTimeout(() => setHighlightShare({ open: true, highlight: h }), 50); }, []);
  const _onHighlightDelete = useCallback(async (h) => {
    if (!h) return;
    try { await api.statusHighlightDelete?.(h.id); } catch {}
    setHighlights(prev => prev.filter(x => x.id !== h.id));
  }, []);
  const saveNickname = useCallback(async (val) => {
    const em = identity?.email;
    if (!em) return;
    try {
      const { setNicknameLocal } = require('../services/nicknames');
      const v = String(val || '').trim();
      await api.chatNicknameSet(em, v);
      setNicknameLocal(em, v);
      setNicknameValue(v);
    } catch {}
  }, [identity?.email]);
  const handleNicknameFromMenu = useCallback(() => {
    if (!identity?.email) return;
    if (WEB) {
      if (typeof window === 'undefined' || !window.prompt) return;
      const current = window.prompt(t?.('profile.nicknamePrompt') || 'Como você quer chamar essa pessoa? (deixa vazio pra remover)', nicknameValue || '');
      if (current !== null) saveNickname(current);
      return;
    }
    if (Platform.OS === 'ios') {
      try {
        Alert.prompt(
          t?.('profile.nickname') || 'Apelido',
          t?.('profile.nicknameHint') || 'Só você vê este nome.',
          [
            { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
            { text: t?.('common.save') || 'Salvar', onPress: (txt) => saveNickname(txt) },
          ],
          'plain-text', nicknameValue || ''
        );
        return;
      } catch {}
    }
    // Android (ou Alert.prompt indisponível): diálogo próprio.
    _nickDialogRef.current?.open?.(nicknameValue || '');
  }, [identity?.email, nicknameValue, saveNickname, t]);

  // [2026-05-18 IG-Pro] Action sheet for highlight long-press. For owners
  // we show Edit + Share + Delete; for viewers only Share. Routing into
  // HighlightEditSheet / HighlightShareSheet keeps Profile.js lean.
  const highlightActionSheetNode = (
    <ProfileHighlightMenuSheet
      ref={_hlSheetRef}
      native={_profSheetsNative}
      colors={colors}
      isDark={isDark}
      t={t}
      onEdit={_onHighlightEdit}
      onShare={_onHighlightShare}
      onDelete={_onHighlightDelete}
    />
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
    <ProfileMoreMenuSheet
      ref={_moreSheetRef}
      native={_profSheetsNative}
      colors={colors}
      isDark={isDark}
      t={t}
      showContactRows={!!identity?.email && identity.email !== currentUser?.email}
      nicknameValue={nicknameValue}
      hideStatusFromContact={hideStatusFromContact}
      hideStatusSaving={hideStatusSaving}
      onShare={handleShareProfile}
      onNickname={handleNicknameFromMenu}
      onToggleHideStatus={handleToggleHideStatus}
      onBlock={handleBlock}
      onReport={handleReport}
    />
  ) : null;

  // WhatsApp-style nickname editor — cross-platform so Android also has a way
  // to rename contacts (iOS-only Alert.prompt was the gap "não dá pra trocar nome").
  const nicknameModalNode = !actions.is_self && identity?.email ? (
    <ProfileNicknameDialog
      ref={_nickDialogRef}
      native={_profSheetsNative}
      colors={colors}
      t={t}
      placeholder={identity?.name || identity?.email?.split('@')[0] || ''}
      onSave={saveNickname}
    />
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
        // [2026-10-19 me-cover] mesmo cache do topo "Você" (capa/nome na hora).
        try { require('../services/profileCover').patchMyProfileCache(next, identity?.email); } catch {}
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
    // Multi-clip recording (ffmpeg stitch fallback) and multi-select gallery
    // emit {multi:true, items} with no top-level uri. ChatListTab and
    // ChatStatusTab already ship this branch; this was the third forgotten
    // callsite (same story as the capture.music fix below) — the guard under
    // it silently discarded every multi payload from the avatar flow.
    if (capture?.multi && Array.isArray(capture.items) && capture.items.length > 1) {
      setStatusPublishing(true);
      try {
        // Picked song used to be dropped on every multi-clip publish —
        // statusCarouselPublish rides it on the first slide (backend pair).
        const multiMusic = capture.music ? {
          title: capture.music.title || capture.music.name || '',
          artist: capture.music.artist || '',
          previewUrl: capture.music.previewUrl || capture.music.preview_url || capture.music.url || '',
          coverUrl: capture.music.coverUrl || capture.music.cover_url || capture.music.artwork || '',
          startMs: capture.music.startMs ?? capture.music.start_ms ?? 0,
        } : null;
        const carouselItems = [];
        for (const it of capture.items) {
          const isVideo = it.type === 'video';
          const file = {
            uri: it.uri,
            name: isVideo ? 'status.mp4' : 'status.jpg',
            type: isVideo ? 'video/mp4' : 'image/jpeg',
          };
          try {
            const up = await api.statusUpload?.(file);
            if (up?.success && up.data?.url) {
              carouselItems.push({
                media_url: up.data.url,
                type: isVideo ? 'video' : 'image',
                background: '#000000',
              });
            }
          } catch (e) { console.warn('[avatar carousel upload]', e?.message); }
        }
        if (carouselItems.length > 0 && api.statusCarouselPublish) {
          const cr = await api.statusCarouselPublish(carouselItems, { privacy: 'all', music: multiMusic });
          if (cr?.success) {
            invalidateProfileCache(fetchKey);
            setRetryCounter(c => c + 1);
            if (carouselItems.length < capture.items.length) {
              Alert.alert(t?.('common.error') || 'Erro', `${t?.('status.publishFailed') || 'Não foi possível publicar o status.'} (${capture.items.length - carouselItems.length}/${capture.items.length})`);
            }
          } else {
            Alert.alert(t?.('common.error') || 'Erro', cr?.message || t?.('status.publishFailed') || 'Não foi possível publicar o status.');
          }
        } else {
          Alert.alert(t?.('common.error') || 'Erro', t?.('status.publishFailed') || 'Não foi possível publicar o status.');
        }
      } catch (e) {
        Alert.alert(t?.('common.error') || 'Erro', e?.message || t?.('common.failed') || 'Falhou');
      } finally {
        setStatusPublishing(false);
      }
      return;
    }
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
        // 2026-05-28 Lester QA: música selecionada no StatusCamera (pela foto
        // de perfil) não aparecia no status publicado. handleAvatarCameraCapture
        // ignorava `capture.music`. ChatStatusTab tinha o mesmo bug
        // (já corrigido no commit b05ff920). Aqui é o terceiro callsite.
        const camMusic = capture?.music ? {
          title: capture.music.title || capture.music.name || '',
          artist: capture.music.artist || '',
          previewUrl: capture.music.previewUrl || capture.music.preview_url || capture.music.url || '',
          coverUrl: capture.music.coverUrl || capture.music.cover_url || capture.music.artwork || '',
          // music_start_ms — user-picked start offset (the "trecho" trimmed in
          // StatusCamera). Forward so statusPublish persists it and StoryViewer
          // seeks the player there on load.
          startMs: capture.music.startMs ?? capture.music.start_ms ?? 0,
        } : null;
        const r = await api.statusPublish?.(uploadR.data.url, statusType, '#000000', camMusic, extraMeta);
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
      Alert.alert(t?.('common.error') || 'Erro', e?.message || t?.('common.failed') || 'Falhou');
    } finally {
      setStatusPublishing(false);
    }
  }, [fetchKey, t]);

  const _onAvatarAddStatus = useCallback(() => { setStatusCameraOpen(true); }, []);
  const _onAvatarEditPhoto = () => { if (_npEditOn && _npEdit.start()) return; setEditOpen(true); };
  const _onAvatarViewPhoto = () => {
    // Bug 7174: AvatarLightbox (foto em tela cheia c/ pinça e arrastar p/ fechar),
    // não StoryViewer/HighlightViewer (cromado de story).
    const url = identity?.avatar_url || (identity?.email ? api.getAvatarUrlForEmail?.(identity.email) : '');
    if (_ppHasGallery()) { _ppOpenGallery(0, () => { if (url) setAvatarLightboxOpen(true); }); return; } // [perfil-fotos 2026-10-19]
    if (url) setAvatarLightboxOpen(true);
  };
  const avatarActionNode = actions?.is_self ? (
    <ProfileAvatarActionsSheet
      ref={_avatarSheetRef}
      native={_profSheetsNative}
      colors={colors}
      isDark={isDark}
      t={t}
      onAddStatus={_onAvatarAddStatus}
      onEditPhoto={_onAvatarEditPhoto}
      onViewPhoto={_onAvatarViewPhoto}
      onAddPhoto={_ppOn ? () => { _ppAddPhoto(); } : undefined}
      onPublishPost={ProfilePhotos.isProfilePostsCiEnabled() ? () => { _ppPublish(); } : undefined}
    />
  ) : null;

  // [2026-05-26 P0 Android] StatusCamera is a heavy native component — it calls
  // `useCameraPermissions()` (expo-camera) at MOUNT, which reaches into the
  // native ExpoCamera module the moment the component mounts, even while the
  // sheet is hidden (visible=false). On Android, opening your OWN profile
  // mounted this hidden camera sheet on every render and a failure in that
  // mount-time native call crashed the whole profile screen (iOS tolerated it).
  // Fix: only mount StatusCamera AFTER the user actually opens it. Defers ALL
  // camera/native initialization off the profile-open path. Pure JS → OTA-able.
  // 2026-05-28 Lester QA: opening "Adicionar ao status" pela foto de perfil
  // crashava o app — StatusCamera mounta StatusVisionCamera via React.lazy,
  // e qualquer erro em runtime (módulo nativo faltando em build velho, frame
  // processor falhando, etc.) propaga até o root sem boundary. Wrap aqui
  // pra fechar o sheet em vez de derrubar a tela inteira.
  const statusCameraNode = actions?.is_self && statusCameraOpen ? (
    <ProfileStatusCameraBoundary onCrash={() => setStatusCameraOpen(false)}>
      <StatusCamera
        visible={statusCameraOpen}
        onClose={() => setStatusCameraOpen(false)}
        onCapture={handleAvatarCameraCapture}
        // [status-texto 2026-10-14] "Texto" → editor de status de texto (hospedado na aba de conversas)
        onOpenText={() => {
          setStatusCameraOpen(false);
          setTimeout(() => {
            try {
              const R = require('./status/statusRingStore');
              if (!R.openTextStatusComposer()) router?.push?.('/chat?tab=status&new=1&text=1');
            } catch {}
          }, Platform.OS === 'ios' ? 450 : 0);
        }}
        t={t}
      />
    </ProfileStatusCameraBoundary>
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
      <ActivityIndicator size="small" color={colors.primary} />
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
      userName={identity?.name}
      username={identity?.username}
      avatarUrl={identity?.avatar_url}
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
  // [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
  // sheet stays defined but is suppressed so it can't surface even via
  // a stray setSendDiamondOpen(true) path.
  const sendDiamondNode = DIAMONDS_ENABLED && !actions.is_self && identity?.email ? (
    <SendDiamondSheet
      visible={sendDiamondOpen}
      onClose={() => setSendDiamondOpen(false)}
      toEmail={identity.email}
      toName={identity.name || nicknameValue || identity.email.split('@')[0]}
      toAvatarUrl={identity.avatar_url}
    />
  ) : null;

  const reportNode = !actions.is_self && identity?.email ? (
    <ReportSheet visible={reportOpen} onClose={() => setReportOpen(false)} native={mode !== 'peek' /* [2026-10-15 native-sheets-v2] peek = dentro de <Modal> RN → folha JS */}
      target={{ content_type: 'profile', content_id: identity.email, reported_email: identity.email }} />
  ) : null;

  const _gridHandlersRef = useRef(null);
  _gridHandlersRef.current = { handleOpenPost, router, t, isSelf: _isSelf };
  const onGridItemPress = useCallback((it, kind) => {
    const h = _gridHandlersRef.current;
    if (!h || !it) return;
    if (kind === 'lives') {
      if (!it.session_id) return;
      h.router?.push(`/live-replay?id=${encodeURIComponent(it.session_id)}`);
      return;
    }
    if (kind === 'posts') {
      h.handleOpenPost(it, (it.type === 'video' || it.media_type === 'video') ? 'reels' : 'posts');
      return;
    }
    h.handleOpenPost(it, kind);
  }, []);
  const onGridItemLongPress = useCallback((rec, kind) => {
    const h = _gridHandlersRef.current;
    if (!h || kind !== 'lives' || !h.isSelf || !rec?.session_id) return;
    const tt = h.t;
    // Own-profile only — host can delete their saved replay (mesmo confirm de lives-saved.js).
    Alert.alert(
      tt?.('liveReplay.deleteTitle') || 'Excluir replay?',
      tt?.('liveReplay.deleteConfirm') || 'Isso vai apagar permanentemente a gravação.',
      [
        { text: tt?.('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: tt?.('liveReplay.deleteConfirmBtn') || 'Excluir',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await api.liveRecordingDelete(rec.session_id);
              if (res?.success) setLives(prev => prev.filter(r => r.session_id !== rec.session_id));
            } catch {}
          },
        },
      ]
    );
  }, []);
  const onGridCreate = useCallback(() => { try { _gridHandlersRef.current?.router?.push('/video-studio/camera'); } catch {} }, []);
  const _createLabel = (() => { const v = t?.('videoStudio.create'); return v && v !== 'videoStudio.create' ? v : 'Criar'; })();
  const renderGridRow = useCallback(({ item }) => (
    <ProfileGridRow
      row={item}
      size={gridSize}
      kind={_gridKind}
      onItemPress={onGridItemPress}
      onItemLongPress={onGridItemLongPress}
      onCreate={onGridCreate}
      createLabel={_createLabel}
      isDark={isDark}
      t={t}
    />
  ), [gridSize, _gridKind, onGridItemPress, onGridItemLongPress, onGridCreate, _createLabel, isDark, t]);
  // So pagina depois que a pessoa ROLOU: com a grade curta o onEndReached disparava
  // ja na abertura (30 tiles a mais + requisicao no caminho critico).
  const _gridUserScrolledRef = useRef(false);
  const onGridEndReached = useCallback(() => {
    if (_gridUserScrolledRef.current && activeTab === 'posts' && _canPageMore) loadMorePosts();
  }, [activeTab, _canPageMore, loadMorePosts]);
  const onGridScroll = useCallback((e) => {
    if (_gridUserScrolledRef.current) return;
    const ne = e?.nativeEvent;
    if (!ne || (ne.contentOffset?.y || 0) <= 0) return;
    _gridUserScrolledRef.current = true;
    // ja estava perto do fim (grade curta): o onEndReached nao dispara de novo sozinho
    const rest = (ne.contentSize?.height || 0) - (ne.contentOffset.y + (ne.layoutMeasurement?.height || 0));
    if (rest < (ne.layoutMeasurement?.height || 0) * 0.8) onGridEndReached();
  }, [onGridEndReached]);
  const [_gridListW, setGridListW] = useState(0);
  const onGridListLayout = useCallback((e) => {
    const w = Math.round(e?.nativeEvent?.layout?.width || 0);
    if (w) setGridListW(prev => (prev === w ? prev : w));
  }, []);
  const _gridPadX = _gridListW ? Math.max(0, Math.floor((_gridListW - computeContentMaxWidth(SCREEN_W)) / 2)) : 0;
  const gridFooter = morePostsLoading && activeTab === 'posts'
    ? <View style={{ paddingVertical: 18, alignItems: 'center' }}><ActivityIndicator color={colors?.primary} /></View>
    : null;
  // [2026-10-16 native-media-grid] eventos da grade nativa -> mesmos handlers.
  const _nativeGridRef = useRef(nativeGrid);
  _nativeGridRef.current = nativeGrid;
  const _endPendingRef = useRef(false);
  const onNativeGridPress = useCallback((e) => {
    if (e?.create) { onGridCreate(); return; }
    const g = _nativeGridRef.current;
    const it = g?.byKey?.get(String(e?.key));
    if (it) onGridItemPress(it, g.kind);
  }, [onGridCreate, onGridItemPress]);
  const onNativeGridLongPress = useCallback((e) => {
    const g = _nativeGridRef.current;
    const it = g?.byKey?.get(String(e?.key));
    if (it) onGridItemLongPress(it, g.kind);
  }, [onGridItemLongPress]);
  const onNativeGridScrollBegin = useCallback(() => {
    if (_gridUserScrolledRef.current) return;
    _gridUserScrolledRef.current = true;
    // o fim ja tinha chegado antes do 1o arrasto (grade curta): pagina agora
    if (_endPendingRef.current) { _endPendingRef.current = false; onGridEndReached(); }
  }, [onGridEndReached]);
  const onNativeGridEnd = useCallback(() => {
    if (!_gridUserScrolledRef.current) { _endPendingRef.current = true; return; }
    onGridEndReached();
  }, [onGridEndReached]);
  const nativeGridTheme = useMemo(() => ({
    bg: (typeof colors?.background === 'string' && /^#[0-9a-f]{6}$/i.test(colors.background)) ? colors.background : (isDark ? '#000000' : '#FFFFFF'),
    placeholder: isDark ? '#1C1C1E' : '#E9E9EB',
    sectionText: isDark ? '#F1F3F5' : '#111111',
    createBg: isDark ? '#0A0A0A' : '#FAFAFA',
    createText: isDark ? '#F1F3F5' : '#111111',
  }), [colors?.background, isDark]);

  // ─── [2026-10-18 profile-native] Perfil Telegram NATIVO ────────────────
  // Mesma view da "Dados do contato" (ChatyyChatInfo, api ≥ 3) com
  // descritores de perfil (components/profile/nativeProfileInfo.js). Toda
  // linha chama os MESMOS handlers/folhas da versão JS abaixo. Gate: rota
  // pediu (nativeProfile) + binário api ≥ 3 + kill switch OTA
  // globalThis.__chatyy_native_profile = false; erro nativo → volta ao JS.
  // _npOn / _npActive: calculados lá em cima (antes do `body`) — [2026-10-19 profile-native-first].
  useEffect(() => { try { onNativeActive?.(_npActive); } catch {} }, [_npActive, onNativeActive]);
  // ─── [2026-10-18 profile-edit-native] "Editar" = MESMA tela nativa em modo
  // edição (Telegram). Binário api ≥ 4 + kill switch
  // globalThis.__chatyy_native_profile_edit = false → folha JS de sempre.
  const _npEditOn = _npActive && !!actions?.is_self && isNativeProfileEditEnabled();
  const _npEdit = useNativeProfileEdit({
    t,
    identity,
    enabled: _npEditOn,
    abs: resolveMedia,
    onSaved: (next) => {
      setData(prev => prev ? { ...prev, identity: { ...prev.identity, ...next } } : prev);
      invalidateProfileCache(fetchKey);
      // [2026-10-19 me-cover] capa trocada no editor nativo → topo "Você" na hora.
      try { require('../services/profileCover').patchMyProfileCache(next, identity?.email); } catch {}
      try { if (identity?.username && identity.username !== fetchKey) invalidateProfileCache(identity.username); } catch {}
    },
    onAvatarChanged: (r) => { invalidateProfileCache(fetchKey); if (r && r.success) { try { _ppAfterAvatarChange(r); } catch {} } },
    // Aberto direto no modo edição (/u/<me>?edit=1, tela "Você") → Concluído/
    // Cancelar voltam para quem abriu, como no Telegram.
    onClosed: () => { if (_autoEditFiredRef.current) _npBack(); },
    onRow: (rid) => {
      if (rid === 'phone') { _npEdit.close(true); _npGo('/settings-section?section=account&anchor=security'); return; }
      if (rid === 'privacy') { _npGo('/settings-section?section=privacy'); return; }
      if (rid === 'more') { _npEdit.close(true); _npGo('/edit-profile?legacy=1'); return; }
      if (rid === 'email' && identity?.email) _npCopy(identity.email);
      // [perfil-fotos 2026-10-19] atalhos do editor nativo.
      if (rid === 'pp_add') { _ppAddPhoto(); return; }
      if (rid === 'pp_publish') { _npEdit.close(true); _ppPublish(); }
    },
  });
  const _autoEditFiredRef = useRef(false);
  useEffect(() => {
    if (!autoEdit || _autoEditFiredRef.current || !_npEditOn) return;
    _autoEditFiredRef.current = true;
    _npEdit.start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit, _npEditOn]);
  useEffect(() => { try { onNativeEditActive?.(!!_npEdit.active); } catch {} }, [_npEdit.active, onNativeEditActive]);
  const _npEditBackRef = useRef(null);
  _npEditBackRef.current = _npEdit.active ? _npEdit.back : null;
  useEffect(() => {
    if (Platform.OS !== 'android' || !_npEdit.active) return undefined;
    let sub = null;
    try {
      sub = require('react-native').BackHandler.addEventListener('hardwareBackPress', () => {
        const fn = _npEditBackRef.current;
        if (!fn) return false;
        fn();
        return true;
      });
    } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [_npEdit.active]);
  const _npGo = (href) => { try { if (router?.push) router.push(href); } catch {} };
  const _npKey = identity?.username || identity?.email || fetchKey || '';
  const _npGrid = (tab) => _npGo(`/u/${encodeURIComponent(String(_npKey))}?grid=1${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
  // [2026-10-19 profile-grid-native] Toque na grade NATIVA → visualizador de
  // mídia NATIVO (modules/expo-media-viewer: pager + zoom + vídeo) com as
  // publicações carregadas. Sem módulo / item sem mídia real (vídeo só com
  // pôster) / falhou → visualizador JS de antes (ProfilePostViewer, com
  // curtidas/comentários). Opt-in: globalThis.__chatyy_profile_native_viewer = true (padrão = JS c/ curtidas).
  const _npPostMedia = (p) => {
    if (!p || p.__create) return null;
    const mu = Array.isArray(p.media_urls) ? p.media_urls : [];
    const isVid = p.type === 'video' || p.media_type === 'video';
    const main = mu[0] || (isVid ? (p.video_url || '') : (p.url || p.thumbnail || ''));
    if (!main) return null;
    const uri = resolveMedia(String(main));
    if (!uri || /\/api\//.test(uri)) return null; // viewer nativo não manda Bearer
    const video = isVid || /\.(mp4|mov|webm|m4v|3gp)(\?|$)/i.test(uri);
    const thumb = p.thumbnail || p.thumbnail_url || '';
    return {
      uri,
      thumbUri: thumb ? resolveMedia(String(thumb)) : null,
      type: video ? 'video' : 'image',
      caption: String(p.caption || '').slice(0, 300),
      senderName: identity?.name || '',
      createdAt: p.created_at || null,
    };
  };
  const _npOpenPost = (it) => {
    if (it && it.__pending && openPendingPostMenu(it)) return; // [post-perfil 2026-10-20]
    const jsOpen = () => { try { onGridItemPress(it, 'posts'); } catch {} };
    let off = false;
    try { off = globalThis.__chatyy_profile_native_viewer !== true; } catch {}
    if (off || !it || !_npPostMedia(it)) { jsOpen(); return; }
    const list = (combinedPostsAll || []).filter((p) => p && !p.__create);
    const idx = list.findIndex((p) => String(p.id) === String(it.id));
    if (idx < 0) { jsOpen(); return; }
    let nmo = null;
    try { nmo = require('../services/nativeMediaOpen'); } catch { nmo = null; }
    if (!nmo || !nmo.nativeMediaAlways?.()) { jsOpen(); return; }
    Promise.resolve(nmo.openNativeMediaList({
      list,
      index: idx,
      toItem: _npPostMedia,
      t,
      allowShare: true,
      allowSave: true,
    })).then((sid) => { if (!sid) jsOpen(); }, jsOpen);
  };
  // [perfil-fotos 2026-10-19] galeria em tela cheia (viewer nativo ou JS) a partir da foto `index`.
  const _ppHasGallery = () => _ppOn && Array.isArray(_ppPhotos) && _ppPhotos.length > 0;
  const _ppOpenGallery = (index, onFail) => {
    const avatarUrl = identity?.avatar_url ? resolveMedia(String(identity.avatar_url)) : (identity?.email ? api.getAvatarUrlForEmail?.(identity.email) : '');
    Promise.resolve(ProfilePhotos.openProfilePhotoGallery({
      email: identity?.email || '', name: identity?.name || '', photos: _ppPhotos, avatarUrl, index, t, isSelf: !!actions?.is_self,
    })).then((ok) => { if (!ok && onFail) onFail(); }, () => { if (onFail) onFail(); });
  };
  const _ppAfterAvatarChange = (r) => {
    const d = r && r.success ? (r.data || {}) : null;
    if (!d) return;
    invalidateProfileCache(fetchKey);
    if (d.avatar_version) {
      setData(prev => prev ? { ...prev, identity: { ...prev.identity, avatar_version: d.avatar_version, ...(d.avatar_url ? { avatar_url: d.avatar_url } : null) } } : prev);
    }
  };
  const _ppAddPhoto = async () => {
    const r = await ProfilePhotos.pickAndAddProfilePhoto({ t, email: identity?.email || '' });
    _ppAfterAvatarChange(r);
  };
  const _ppPublish = () => { ProfilePhotos.startProfilePost(router, t, { from: 'profile' }); };
  const _ppPostsOn = ProfilePhotos.isProfilePostsCiEnabled();
  const _npAvatar = (index, uri) => {
    if (_ppHasGallery() && (index > 0 || (stories.length === 0 && !actions?.is_self))) {
      _ppOpenGallery(index, () => { if (index > 0 && uri) { setLightboxUri(uri); setAvatarLightboxOpen(true); } else { setLightboxUri(null); setAvatarLightboxOpen(true); } });
      return;
    }
    if (index > 0 && uri) { setLightboxUri(uri); setAvatarLightboxOpen(true); return; }
    if (stories.length > 0) { openStoriesAt(0); return; }
    if (actions?.is_self) { setAvatarActionOpen(true); return; }
    const url = identity?.avatar_url || (identity?.email ? api.getAvatarUrlForEmail?.(identity.email) : '');
    if (url) { setLightboxUri(null); setAvatarLightboxOpen(true); }
  };
  const _npCopy = async (text) => {
    if (!text) return;
    try {
      const Clipboard = require('expo-clipboard');
      await Clipboard.setStringAsync(String(text));
      try { require('../services/haptics').HapticsCompat.selectionAsync?.(); } catch {}
      const v = t?.('nativeProfile.copied');
      const _msg = v && v !== 'nativeProfile.copied' ? v : 'Copiado';
      try { require('./ui/Toast').showToast({ message: _msg, kind: 'success' }); } catch { Alert.alert(_msg, String(text)); } // [2026-10-21 toasts]
    } catch {}
  };
  const _npLogout = () => {
    const tr = (k, fb) => { const v = t?.(k); return v && v !== k ? v : fb; };
    Alert.alert(tr('settings.logoutConfirmTitle', 'Sair da conta?'), tr('settings.logoutConfirmMessage', ''), [
      { text: tr('common.cancel', 'Cancelar'), style: 'cancel' },
      {
        text: tr('settings.logout', 'Sair'),
        style: 'destructive',
        onPress: async () => {
          try {
            if (onLogout) await onLogout();
            else if (authLogout) { await authLogout(); router?.replace?.('/login'); }
          } catch {}
        },
      },
    ]);
  };
  const _npInfo = _npActive ? buildNativeProfileInfo({
    t,
    mode: (actions?.is_self || (!identity && _npIdentity?.__self)) ? 'self' : 'user',
    identity: _npIdentity,
    // [2026-10-19 profile-native-first] semente (sem profile_get ainda): sem
    // ações/contagens/linhas de ação até os dados reais chegarem.
    loading: !identity,
    // [2026-10-19 profile-grid-native] api ≥ 5: capa no cabeçalho, anel de
    // status no avatar, grade 3 colunas de publicações e faixa de destaques nativas.
    v5: _npV5,
    // [perfil-fotos 2026-10-19] galeria no carrossel + deslizar (api 6) + atalhos do dono.
    gallery: _ppOn ? _ppPhotos : null,
    v6: _npV5 && chatInfoV6(),
    // [2026-10-21 foto-capa-studio] sem a linha "Adicionar foto de perfil" (foto troca no Editar).
    ownerCta: actions?.is_self ? { photo: false, post: _ppPostsOn } : null,
    storyRing: stories.length > 0 ? ((!actions?.is_self && _profileStatusRing?.allViewed) ? 'seen' : 'unseen') : '',
    postsHasMore: _canPageMore,
    presenceText,
    social,
    actions,
    nickname: nicknameValue,
    stories,
    highlights,
    posts: combinedPostsAll,
    postsTotal: (posts.length || 0) + (reels.length || 0),
    sharedMedia,
    commonChats,
    liveSessionId,
    diamonds: !!DIAMONDS_ENABLED,
    planName: PLAN_NAME,
    planDesc: (() => { const v = t?.('chatyyOne.rowDesc'); return v && v !== 'chatyyOne.rowDesc' ? v : ''; })(),
    abs: resolveMedia,
    on: {
      edit: () => { if (_npEditOn && _npEdit.start()) return; setEditOpen(true); },
      avatar: _npAvatar,
      stories: () => openStoriesAt(0),
      qr: () => _npGo('/profile-qr'),
      share: handleShareProfile,
      follow: handleFollow,
      chat: handleChat,
      call: handleCall,
      video: handleVideo,
      email: handleEmail,
      followers: (tab) => (onOpenFollowers ? onOpenFollowers(identity.email, tab) : setFollowersTab(tab)),
      grid: _npGrid,
      post: _npOpenPost,
      highlight: (h) => { try { openHighlight(h); } catch {} },
      highlightMenu: (h) => {
        try { require('../services/haptics').hapticEvent('longPress'); } catch {}
        setHighlightSheet({ open: true, highlight: { id: h.id, title: h.title, cover_url: h.cover_url, isSelf: !!actions?.is_self } });
      },
      morePosts: () => { try { loadMorePosts(); } catch {} },
      addPhoto: _ppAddPhoto,
      publish: _ppPublish,
      group: (c) => { try { require('../services/openConversation').openConversation(`/chat-conversation?id=${c.id}`); } catch {} },
      menu: () => setMenuOpen(true),
      block: handleBlock,
      report: handleReport,
      live: () => { if (liveSessionId) _npGo(`/live-viewer?sessionId=${encodeURIComponent(liveSessionId)}&hostEmail=${encodeURIComponent(identity.email)}&hostName=${encodeURIComponent(identity.name || (identity.email || '').split('@')[0])}`); },
      gift: () => setSendDiamondOpen(true),
      go: _npGo,
      logout: _npLogout,
      copy: _npCopy,
      link: (url) => { try { Linking.openURL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch {} },
    },
  }) : null;
  const _npBack = () => { try { if (router?.canGoBack?.()) router.back(); else router?.replace?.('/chat'); } catch {} };
  // [2026-10-19 profile-native-first] folhas/visualizadores JS (Modal) montam só
  // depois do 1º quadro nativo (ou na hora em que algum abre).
  const _npAnyOpen = !!(viewer.open || storyViewer.open || avatarLightboxOpen || highlightViewer.open
    || highlightEdit.open || highlightShare.open || editOpen || statusCameraOpen || statusPublishing
    || settingsOpen || sendDiamondOpen || reportOpen || followersTab);
  const _npOverlaysOn = !_npActive || _npOverlaysReady || _npAnyOpen;
  const _npFail = (why) => {
    try { console.warn('[profile-native] fallback JS:', why); require('./../services/crashReporter').reportNativeFallback?.('native_profile_v3', String(why || '')); } catch {}
    setNativeProfileOff(true);
  };

  // ─── Render ──────────────────────────────────────────────────────────
  if (mode === 'full') {
    return (
      <>
        {/* [post-perfil 2026-10-20] progresso das publicações em 2º plano (só o dono) — fica por cima da grade */}
        {_ppSelfEm ? <ProfilePostProgress email={_ppSelfEm} bottom={(Number(nativeBottomInset) || 0) + 16} /> : null}
        {_npInfo ? (
          <NativeChatInfo
            {..._npInfo}
            bottomInset={nativeBottomInset}
            maxWidth={computeContentMaxWidth(SCREEN_W)}
            onFailure={_npFail}
            onClose={_npBack}
            edit={_npEditOn ? _npEdit.edit : null}
            onEdit={_npEdit.onEdit}
            closeLabel={t?.('common.back') || 'Voltar'}
          />
        ) : (_nativeGridOn && !loading && !err) ? (
          <NativeMediaGrid
            style={{ flex: 1, backgroundColor: colors?.background }}
            items={nativeGrid.items}
            header={body}
            footer={gridFooter}
            spacing={1}
            maxContentWidth={computeContentMaxWidth(SCREEN_W)}
            contentInsetBottom={60}
            theme={nativeGridTheme}
            onItemPress={onNativeGridPress}
            onItemLongPress={onNativeGridLongPress}
            onEndReached={onNativeGridEnd}
            onScrollBegin={onNativeGridScrollBegin}
          />
        ) : (_FlashList && !loading && !err) ? (
          <_FlashList
            style={{ flex: 1, backgroundColor: colors?.background }}
            data={gridRows}
            renderItem={renderGridRow}
            keyExtractor={_gridRowKey}
            ListHeaderComponent={body}
            ListFooterComponent={gridFooter}
            onEndReached={onGridEndReached}
            onEndReachedThreshold={0.8}
            onScroll={onGridScroll}
            scrollEventThrottle={64}
            // coluna centrada (web largo/tablet) por padding medido no layout: mesma
            // largura maxima de antes, e a roda do mouse rola em toda a largura
            onLayout={onGridListLayout}
            contentContainerStyle={{ paddingBottom: 60, paddingHorizontal: _gridPadX }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        ) : (
          <ScrollView style={{ flex: 1, backgroundColor: colors?.background }}
            contentContainerStyle={{ paddingBottom: 60, maxWidth: computeContentMaxWidth(SCREEN_W), width: '100%', alignSelf: 'center' }}
          >
            {body}
          </ScrollView>
        )}
        {/* [2026-10-19 profile-native-first] folhas por ref (leves, abertas por
            .open()) ficam sempre montadas; os Modais por estado esperam o 1º quadro. */}
        {selfStatusHostNode}
        {highlightActionSheetNode}
        {avatarActionNode}
        {_npEditOn && _npEdit.studio ? <ProfileMediaStudio {..._npEdit.studio} /> : null}
        {_ppOn ? <ProfilePhotoGalleryHost t={t} onChanged={(d) => _ppAfterAvatarChange({ success: true, data: d || {} })} /> : null}
        {menuNode}
        {nicknameModalNode}
        {_npOverlaysOn ? (
          <>
            {viewerNode}
            {storyViewerNode}
            {avatarLightboxNode}
            {highlightViewerNode}
            {highlightEditNode}
            {highlightShareNode}
            {editNode}
            {statusCameraNode}
            {publishingToastNode}
            {settingsNode}
            {sendDiamondNode}
            {reportNode}
            {followersNode}
          </>
        ) : null}
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
      {selfStatusHostNode}
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
      {reportNode}
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
  // [2026-10-17 drag-dismiss] folha INTEIRA arrasta (RNGH): corpo rola e, no topo,
  // puxar p/ baixo desce o perfil. Sem RNGH/kill switch: só a alça (PanResponder abaixo).
  const drag = useDragToDismiss({ visible: !!visible, onDismiss: onClose });
  const richDrag = !!(drag.enabled && drag.gesture);
  const translateY = useRef(new Animated.Value(0)).current;
  const backdropOpacity = useRef(new Animated.Value(1)).current;
  // Drives the inverse fade (closer to bottom = more transparent backdrop)
  // so the dismiss feels like one fluid gesture.
  const _commitClose = (vy = 0) => {
    // [2026-10-16 motion] flick → a folha segue a velocidade do dedo.
    const flick = vy > 0 && motionEnabled('sheet_drag');
    Animated.parallel([
      flick
        ? Animated.spring(translateY, { toValue: SH, velocity: vy * 1000, ...Springs.sheet, overshootClamping: true, useNativeDriver: true })
        : Animated.timing(translateY, { toValue: SH, duration: 220, easing: Easing.bezier(0.55, 0.06, 0.68, 0.19), useNativeDriver: true }),
      Animated.timing(backdropOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      try { onClose?.(); } catch {}
      // Reset for next mount; otherwise the next open animates from offscreen.
      translateY.setValue(0);
      backdropOpacity.setValue(1);
    });
  };
  const _snapBack = (vy = 0) => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, ...Springs.sheet, velocity: vy * 1000, useNativeDriver: true }),
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
        if (g.dy > 110 || g.vy > 0.6) _commitClose(g.vy); else _snapBack(g.vy);
      },
      onPanResponderTerminate: () => _snapBack(),
    })
  ).current;

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <DragSheetRoot>
      <View style={{ flex: 1 }}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', opacity: richDrag ? Animated.multiply(backdropOpacity, drag.backdropOpacity) : backdropOpacity }]} />
        <Pressable style={{ flex: 1 }} onPress={() => _commitClose()} />
        <DragPanel
          drag={drag}
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
            {...(richDrag ? null : panResponder.panHandlers)}
            style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 8 }}
          >
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          {/* Close (X) — kept for non-gesture dismissal (web, accessibility) */}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => _commitClose()} style={{ position: 'absolute', right: 12, top: 10, padding: 8, zIndex: 10 }}>
            <IconX size={20} color={colors?.textSecondary || '#888'} />
          </TouchableOpacity>
          <DragScroll drag={drag}><ScrollView showsVerticalScrollIndicator={false}>{body}</ScrollView></DragScroll>
        </DragPanel>
      </View>
      </DragSheetRoot>
      {extras}
    </Modal>
  );
}
