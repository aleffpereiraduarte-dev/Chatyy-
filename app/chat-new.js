import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import PressableRow from '../components/PressableRow'; // [2026-10-07 app-feel-ui] native cell feedback
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, Image,
  FlatList, ActivityIndicator, Alert, Platform, SectionList, Share, Linking,
  ScrollView, Modal, ActionSheetIOS, Animated, AppState,
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../components/nativeHeader'; // [2026-10-07 app-feel-nav]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { getCached, getCachedSync, setCache } from '../services/cache';
import { syncContacts, getHomeDialDigits, subscribeContactsChanged, presentNewContactForm } from '../services/contactSync';
import { prettifyHandle } from '../services/displayName';
import { buildContactQrPayload, buildProfileLink, parseContactQr } from '../utils/contactQr';
import {
  IconArrowLeft, IconSearch, IconX, IconUsers, IconMessageSquare,
  IconCheck, IconPlus, IconMail, IconRefresh, IconClock, IconUserPlus,
  IllustrationSearch, IconCamera, IconShare,
  IconChevronDown,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import BroadcastModal from '../components/BroadcastModal';
import { ListSkeleton } from '../components/SkeletonLoader';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

// Megaphone SVG for broadcast list rows — UI rule bans emoji glyphs, so
// this draws the icon inline via react-native-svg. Matches the stroke
// weight of the other components/Icons.js glyphs (1.8 round-cap).
const _SvgMod = require('react-native-svg');
const _BSvg = _SvgMod.default || _SvgMod.Svg;
const _BPath = _SvgMod.Path;
// [2026-10-09 find-contacts] QR icon as real SVG (was a "⊞" text glyph).
function IconQrCode({ size = 24, color = '#000' }) {
  return (
    <_BSvg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <_BPath d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
      <_BPath d="M14 14h2v2h-2zM18 14h2M14 18v2M18 18h2v2h-2z" />
    </_BSvg>
  );
}

// [2026-10-09 find-contacts] WhatsApp-style shortcut tile (round black icon +
// label) for the top of "Nova conversa".
function ShortcutTile({ label, onPress, colors, isDark, children }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={sty.shortcutTile}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[sty.shortcutIcon, isDark && sty.iconChipDark]}>{children}</View>
      <Text style={[sty.shortcutLabel, { color: colors.text }]} numberOfLines={2}>{label}</Text>
    </TouchableOpacity>
  );
}

function IconBroadcastGlyph({ size = 18, color = '#fff' }) {
  return (
    <_BSvg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <_BPath d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z" />
      <_BPath d="M16 8a5 5 0 0 1 0 8" />
      <_BPath d="M19 5a9 9 0 0 1 0 14" />
    </_BSvg>
  );
}

// Tiny "on Chatyy" badge — purple circle with a check, signals that the
// row is a registered Chatyy user. Rendered inline next to the contact name.
function IconChatyyOnChat({ size = 14, color = '#111111' }) {
  return (
    <_BSvg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <_BPath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1.5 14.2l-4-4 1.4-1.4 2.6 2.6 6.6-6.6L18.5 8l-8 8.2z" />
    </_BSvg>
  );
}

// Animated invite pill — wraps TouchableOpacity with press scale 0.97 spring
// so the brand pill feels tactile (WhatsApp/iMessage-style press feedback).
function InvitePill({ onPress, onLongPress, disabled, style, accessibilityLabel, children }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const handleIn = () => Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, tension: 300, friction: 10 }).start();
  const handleOut = () => Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 200, friction: 12 }).start();
  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handleIn}
        onPressOut={handleOut}
        disabled={disabled}
        activeOpacity={0.85}
        style={style}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}

// Highlight matching text in search results
function HighlightText({ text, highlight, style, highlightStyle }) {
  if (!highlight || !text) return <Text style={style} numberOfLines={1}>{text}</Text>;
  const lowerText = text.toLowerCase();
  const lowerHighlight = highlight.toLowerCase();
  const idx = lowerText.indexOf(lowerHighlight);
  if (idx === -1) return <Text style={style} numberOfLines={1}>{text}</Text>;
  return (
    <Text style={style} numberOfLines={1}>
      {text.substring(0, idx)}
      <Text style={[style, highlightStyle]}>{text.substring(idx, idx + highlight.length)}</Text>
      {text.substring(idx + highlight.length)}
    </Text>
  );
}

// Alphabet sidebar for jumping through contacts
function AlphabetSidebar({ letters, onPress, colors }) {
  return (
    <View style={[sty.alphabetSidebar]} pointerEvents="box-none">
      <View style={sty.alphabetInner}>
        {letters.map((letter) => (
          <TouchableOpacity
            key={letter}
            onPress={() => onPress(letter)}
            style={sty.alphabetLetter}
            activeOpacity={0.5}
          >
            <Text style={[sty.alphabetLetterText, { color: colors.primary }]}>{letter}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// Format last seen time — hoisted to module scope so the memoized ContactRow
// below (which lives outside the screen component) can call it. Pure helper;
// takes `t` for i18n. Behavior identical to the previous in-component version.
function formatLastSeen(dateStr, t) {
  if (!dateStr) return '';
  try {
    let d;
    // Handle numeric timestamps (milliseconds since epoch)
    if (typeof dateStr === 'number') {
      d = new Date(dateStr);
    } else {
      let s = String(dateStr);
      // Ensure UTC timestamp is properly parsed
      if (!s.includes('T')) s = s.replace(' ', 'T');
      if (!s.includes('Z') && !s.includes('+')) s += 'Z';
      d = new Date(s);
    }
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMin = Math.floor((now - d) / 60000);
    if (diffMin < 0) return t('time.now'); // future = treat as now
    if (diffMin < 1) return t('time.now');
    if (diffMin < 60) return (t('time.min') || '{n} min').replace('{n}', diffMin);
    const diffH = Math.floor(diffMin / 60);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffH < 24) {
      return `${t('time.today') || 'today'} ${timeStr}`;
    }
    if (diffH < 48) {
      return `${t('time.yesterday') || 'yesterday'} ${timeStr}`;
    }
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${timeStr}`;
  } catch { return ''; }
}

// Memoized contact row — extracted from the old inline `renderContact` arrow so
// the SectionList/FlatList can recycle rows without re-rendering every visible
// cell on each keystroke/selection. React.memo + stable callbacks (passed from
// the screen via useRef-backed wrappers) mean a row only re-renders when its own
// props actually change (its item, `selected`, `invitingEmail`, `searchText`,
// `mode`, `colors`). Behavior/markup are byte-for-byte identical to the previous
// inline renderer — this is purely memoization + style hoisting.
// [2026-10-07 discovery] Real on-device QR (react-native-qrcode-svg, already a
// dependency of /profile-qr) — replaces api.qrserver.com, which received the
// user's e-mail + name in the URL and broke offline.
let QRCodeSvg = null;
try { QRCodeSvg = require('react-native-qrcode-svg').default; } catch {}

// [2026-10-07 discovery] Accent-insensitive fold ("Áléff" → "aleff") for the
// local search pass. String.prototype.normalize can be missing on some Hermes
// builds without Intl → manual map fallback for pt/es/fr diacritics.
const _ACCENT_MAP = { á:'a', à:'a', â:'a', ã:'a', ä:'a', å:'a', é:'e', è:'e', ê:'e', ë:'e', í:'i', ì:'i', î:'i', ï:'i', ó:'o', ò:'o', ô:'o', õ:'o', ö:'o', ú:'u', ù:'u', û:'u', ü:'u', ç:'c', ñ:'n', ý:'y', ÿ:'y' };
function foldSearchText(s) {
  let out = String(s || '').toLowerCase();
  try {
    if (typeof out.normalize === 'function') out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {}
  return out.replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñýÿ]/g, (c) => _ACCENT_MAP[c] || c);
}

const ContactRow = React.memo(function ContactRow({
  item, colors, searchText, mode, selected, invitingEmail, t,
  onMessageYourself, onSelect, onInviteByEmail, onInviteShare, onInviteViaWhatsApp, onShowInviteInput, onInvitePhone,
}) {
  // [2026-10-07 discovery] Section label inside the flat search-results list.
  if (item._isSearchHeader) {
    return (
      <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingTop: 12, paddingBottom: 4 }]} accessibilityRole="header">
        <View style={sty.sectionAccentLine} />
        <Text style={[sty.sectionTitle, { color: colors.textSecondary || colors.text }]} numberOfLines={2}>{item.title}</Text>
      </View>
    );
  }
  // [2026-10-07 discovery] Typed phone number that is NOT on Chatyy → invite
  // row (WhatsApp "Convidar para o WhatsApp": SMS / WhatsApp / compartilhar).
  if (item._isPhoneInvite) {
    return (
      <View style={[sty.contactRow, { borderBottomColor: colors.border }]}>
        <View style={[sty.quickActionIcon, { backgroundColor: colors.onPrimary === '#000000' ? '#2C2C2E' : '#111111', marginRight: 12 }]}>
          <IconUserPlus size={18} color="#fff" />
        </View>
        <View style={sty.contactInfo}>
          <Text style={[sty.contactName, { color: colors.text, fontWeight: '700' }]} numberOfLines={1}>{item.display || item.phone}</Text>
          <Text style={[sty.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
            {t('chat.phoneNotOnChatyy') || 'Este número ainda não usa o Chatyy'}
          </Text>
        </View>
        <InvitePill
          style={[sty.inviteBtn, sty.inviteBtnWithIcon, { backgroundColor: colors.primary }]}
          onPress={() => onInvitePhone && onInvitePhone(item)}
          accessibilityLabel={t('chat.invitePhone') || 'Convidar este número'}
        >
          <IconUserPlus size={13} color={colors.onPrimary || '#fff'} />
          <Text style={[sty.inviteBtnText, { color: colors.onPrimary || '#fff' }]}>{t('chat.invite')}</Text>
        </InvitePill>
      </View>
    );
  }
  // "Message yourself" pinned row — WhatsApp parity (print 7175 top entry).
  if (item._isMessageYourself) {
    return (
      <PressableRow
        style={[sty.contactRow, { borderBottomColor: colors.border }]}
        onPress={onMessageYourself}
        activeOpacity={0.7}
        accessibilityLabel={t('chat.messageYourself') || 'Message yourself'}
        accessibilityRole="button"
      >
        <View style={[sty.contactAvatarRing, { borderColor: colors.border }]}>
          <AvatarCircle email={item.email} name={item.name} size={40} colors={colors} />
        </View>
        <View style={sty.contactInfo}>
          <View style={sty.rowCenterGap6}>
            <Text style={[sty.contactName, { color: colors.text, fontWeight: '700' }]} numberOfLines={1}>
              {item.name} {''}
              <Text style={{ color: colors.textTertiary, fontWeight: '500' }}>
                ({t('chat.youSelf') || t('common.you') || 'Você'})
              </Text>
            </Text>
          </View>
          <Text style={[sty.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
            {t('chat.messageYourself') || 'Message yourself'}
          </Text>
        </View>
      </PressableRow>
    );
  }

  // Placeholder item for web invite section
  if (item._isInvitePlaceholder) {
    return (
      <View style={[sty.contactRow, { borderBottomColor: colors.border, paddingVertical: 16 }]}>
        <View style={[sty.quickActionIcon, { backgroundColor: colors.onPrimary === '#000000' ? '#2C2C2E' : '#111111', marginRight: 12 }]}>
          <IconUserPlus size={18} color="#fff" />
        </View>
        <View style={sty.flex1}>
          <Text style={[sty.contactName, { color: colors.text }]}>{t('chat.inviteFriend')}</Text>
          <Text style={[sty.contactSub, { color: colors.textTertiary }]}>{t('chat.inviteFriendDesc')}</Text>
        </View>
        <InvitePill
          style={[sty.inviteBtn, sty.inviteBtnWithIcon, { backgroundColor: colors.primary }]}
          onPress={() => onShowInviteInput(true)}
          accessibilityLabel={t('chat.invite')}
        >
          <IconUserPlus size={13} color={colors.onPrimary || '#fff'} />
          <Text style={[sty.inviteBtnText, { color: colors.onPrimary || '#fff' }]}>{t('chat.invite')}</Text>
        </InvitePill>
      </View>
    );
  }

  const isChatyyUser = item.isRegistered === true;

  // Non-registered contact - show invite options
  if (!isChatyyUser) {
    // Unified single-pill invite. Was 3 stacked pills (email + share + W)
    // which the user flagged as cluttered (print 2). Now: ONE pill that
    // picks the best channel automatically; long-press surfaces choices.
    // Email wins when available (higher delivery, less noise);
    // otherwise share-sheet on native, copy-link on web.
    const hasEmail = !!item.email;
    const hasPhone = !!item.phone && Platform.OS !== 'web';
    const onTap = () => {
      if (hasEmail) onInviteByEmail(item.email, item.name);
      else onInviteShare(item);
    };
    const onHold = () => {
      if (Platform.OS === 'ios') {
        const opts = [];
        const actions = [];
        if (hasEmail) { opts.push(t('chat.inviteByEmail') || 'Convidar por email'); actions.push(() => onInviteByEmail(item.email, item.name)); }
        if (hasPhone) { opts.push('WhatsApp'); actions.push(() => onInviteViaWhatsApp(item)); }
        opts.push(t('chat.inviteShare') || 'Compartilhar link');
        actions.push(() => onInviteShare(item));
        opts.push(t('common.cancel') || 'Cancelar');
        ActionSheetIOS.showActionSheetWithOptions(
          { options: opts, cancelButtonIndex: opts.length - 1 },
          (idx) => { if (idx >= 0 && idx < actions.length) actions[idx](); }
        );
      } else {
        onInviteShare(item);
      }
    };
    return (
      <View style={[sty.contactRow, { borderBottomColor: colors.border }]}>
        <AvatarCircle email={item.email || ''} name={item.name || item.phone || '?'} size={48} colors={colors} />
        <View style={sty.contactInfo}>
          <HighlightText
            text={item.name || item.phone || '?'}
            highlight={searchText}
            style={[sty.contactName, { color: colors.text }]}
            highlightStyle={{ backgroundColor: '#11111130', fontWeight: '700' }}
          />
          <Text style={[sty.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
            {item.email || item.phone || ''}
          </Text>
        </View>
        <InvitePill
          style={[sty.inviteBtn, sty.inviteBtnWithIcon, { backgroundColor: colors.primary }]}
          onPress={onTap}
          onLongPress={onHold}
          disabled={invitingEmail === item.email}
          accessibilityLabel={t('chat.invite')}
        >
          {invitingEmail === item.email ? (
            <ActivityIndicator size={14} color={colors.onPrimary || '#fff'} />
          ) : (
            <>
              <IconUserPlus size={13} color={colors.onPrimary || '#fff'} />
              <Text style={[sty.inviteBtnText, { color: colors.onPrimary || '#fff' }]}>{t('chat.invite')}</Text>
            </>
          )}
        </InvitePill>
      </View>
    );
  }

  // Registered Chatyy user
  return (
    <PressableRow
      style={[sty.contactRow, { borderBottomColor: colors.border }]}
      onPress={() => onSelect(item)}
      activeOpacity={0.7}
    >
      <View style={[sty.contactAvatarRing, { borderColor: colors.border }]}>
        <AvatarCircle email={item.email} name={item.name || prettifyHandle(item.email)} size={40} colors={colors} />
        {item.online && <View style={[sty.onlineDotSmall, { borderColor: colors.background }]} />}
      </View>
      <View style={sty.contactInfo}>
        <View style={sty.rowCenterGap6Min}>
          <HighlightText
            text={item.name && !item.name.includes('@') ? item.name : prettifyHandle(item.email || item.name || '')}
            highlight={searchText}
            style={[sty.contactName, { color: colors.text, fontWeight: '700', flexShrink: 1 }]}
            highlightStyle={{ backgroundColor: '#11111130', fontWeight: '700' }}
          />
          {/* Tiny Chatyy badge — purple check circle SVG, signals registered user.
              Less noisy than a pill, more affirmative than nothing. Wrapped in a
              flexShrink:0 View so the long name (flexShrink:1) truncates instead
              of pushing this icon off-screen / onto the checkbox. */}
          <View style={sty.shrink0}>
            <IconChatyyOnChat size={13} color={colors.primary} />
          </View>
          {/* "NOVO" badge — WhatsApp-style pill for contacts that just joined
              Chatyy (last 7d via _justJoined flag, populated by friend_suggestions
              backend + contact_joined WS event). Brand purple so it stands out
              without screaming. */}
          {item._justJoined && (
            <View style={[sty.novoBadge, { backgroundColor: colors.primary }]}>
              <Text style={[sty.novoBadgeText, { color: colors.onPrimary || '#fff' }]}>
                {t('chat.newOnChatyy') || 'NOVO'}
              </Text>
            </View>
          )}
        </View>
        <View style={sty.rowCenterGap6Min}>
          <HighlightText
            text={item.email}
            highlight={searchText}
            style={[sty.contactSub, { color: colors.textTertiary, flexShrink: 1 }]}
            highlightStyle={{ backgroundColor: '#11111130' }}
          />
          {item.username ? (
            <Text style={[sty.usernameInline, { color: colors.text }]} numberOfLines={1}>@{item.username}</Text>
          ) : null}
        </View>
        {item.about ? (
          <Text style={[sty.contactAbout, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.about}
          </Text>
        ) : item.last_seen ? (
          <Text style={[sty.contactAbout, { color: colors.textTertiary }]} numberOfLines={1}>
            {t('chat.lastSeen')} {formatLastSeen(item.last_seen, t)}
          </Text>
        ) : null}
      </View>
      {(mode === 'group' || mode === 'channel') && item.email && (
        <View style={[sty.checkbox, {
          backgroundColor: selected ? colors.primary : 'transparent',
          borderColor: selected ? colors.primary : colors.border,
        }]}>
          {selected && <IconCheck size={14} color={colors.onPrimary || '#fff'} />}
        </View>
      )}
    </PressableRow>
  );
});

export default function ChatNewScreen() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const pageParams = useLocalSearchParams();
  // "Pick contact to add to group" flow — tap a contact in the list to
  // add them to the named conv, then navigate back into the conversation.
  const addMemberConvId = pageParams.addMemberToConv ? Number(pageParams.addMemberToConv) : null;
  const pickMode = !!addMemberConvId;
  const insets = useSafeAreaInsets();

  // ── Instant-open cache keys (per-user scoped by services/cache) ──────────
  // Seeding these synchronously at mount lets the contact list paint on the
  // very first frame (no blank white screen) while the network refresh runs
  // in the background. recents/directory differ by pickMode, so their keys
  // carry a suffix to avoid showing the "add member" variant in New Chat.
  const CK_PHONE = 'chatnew:phone';
  const CK_OTHER = 'chatnew:other';
  const CK_SUG = 'chatnew:suggestions';
  const CK_REC = pickMode ? 'chatnew:recents:pick' : 'chatnew:recents';
  const CK_DIR = 'chatnew:directory';
  const CK_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days — contacts change slowly
  const _seed = (k) => { try { const v = getCachedSync(k); return Array.isArray(v) ? v : null; } catch { return null; } };

  const safeAlert = (title, message, buttons) => {
    if (Platform.OS === 'web') {
      if (buttons?.length) {
        const ok = buttons.find(b => b.style !== 'cancel');
        if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
        else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
      } else { window.alert(message || title); }
    } else { Alert.alert(title, message, buttons); }
  };

  const [mode, setMode] = useState('direct');
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // Animated focus border around the search input — brand purple fades in on
  // focus, fades out on blur. Polish hint from product (round 55).
  const searchBorderAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(searchBorderAnim, {
      toValue: searchFocused ? 1 : 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [searchFocused, searchBorderAnim]);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  // Contact lists — seeded synchronously from cache (instant first paint).
  const [phoneContacts, setPhoneContacts] = useState(() => _seed(CK_PHONE) || []);
  const [otherContacts, setOtherContacts] = useState(() => _seed(CK_OTHER) || []);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [directoryUsers, setDirectoryUsers] = useState(() => _seed(CK_DIR) || []); // All Chatyy users
  const [recentContacts, setRecentContacts] = useState(() => _seed(CK_REC) || []); // Recent chats
  const [suggestions, setSuggestions] = useState(() => _seed(CK_SUG) || []); // "Pessoas que você pode conhecer"
  // Loading flags start false when cache already seeded something, so the
  // skeleton/blank branch is skipped and the cached list shows immediately.
  const [loadingRecents, setLoadingRecents] = useState(() => (_seed(CK_REC) || []).length === 0);
  const [loadingDirectory, setLoadingDirectory] = useState(() => (_seed(CK_DIR) || []).length === 0);

  // Invite states
  const [invitingEmail, setInvitingEmail] = useState(null);
  const [showInviteInput, setShowInviteInput] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  // Public channel discovery (Telegram-style)
  const [publicChannels, setPublicChannels] = useState([]);
  const [discoverCategory, setDiscoverCategory] = useState('all');
  const [searchChannelResults, setSearchChannelResults] = useState([]);
  const [joiningChannelId, setJoiningChannelId] = useState(null);

  // Trending hashtags (Telegram-style "Tópicos populares") — only public
  // channels feed this list, so privacy is preserved at the SQL layer.
  const [trendingTags, setTrendingTags] = useState([]);

  // Broadcast lists (Telegram parity) — fetched from chat_broadcast_list.
  // Tapping `+ Nova lista` opens BroadcastModal (multi-select contacts +
  // name input). Tapping an existing list resends from it via
  // chatBroadcastSend. Hidden when in pickMode (the screen is in
  // "add member to group" mode and the user shouldn't see lists then).
  const [broadcastLists, setBroadcastLists] = useState([]);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  // Android composer (no Alert.prompt on Android) — holds the target list
  // object and the message text for the inline broadcast-send modal.
  const [broadcastComposeList, setBroadcastComposeList] = useState(null);
  const [broadcastComposeText, setBroadcastComposeText] = useState('');
  const [broadcastSending, setBroadcastSending] = useState(false);
  // Idempotency key for the blast — created at first press and held across
  // thrown-error retries (modal stays open in .catch) so a timeout-then-retry
  // dedups server-side instead of re-delivering every leg. Cleared whenever
  // the compose session ends (send resolved or modal dismissed): reusing it
  // for a NEW text would make the server dedup-drop the new message.
  const broadcastCmiRef = useRef(null);

  // QR modal
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrMode, setQrMode] = useState('show'); // 'show' or 'scan'
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [qrScanned, setQrScanned] = useState(false);

  const searchTimeout = useRef(null);
  const sectionListRef = useRef(null);
  const hasSyncedRef = useRef(false);
  // [2026-10-09 find-contacts] 'granted' | 'denied' | null (unknown yet) —
  // drives the "Encontre seus contatos" card when the agenda isn't connected.
  const [contactsAccess, setContactsAccess] = useState(null);
  const lastContactSyncRef = useRef(0);
  const silentSyncBusyRef = useRef(false);

  // Auto-sync contacts on first open (native only). syncContacts now shows
  // the consent disclosure modal (Apple guideline 5.1.2) before any data
  // leaves the device, so this auto-trigger is safe even on first launch.
  useEffect(() => {
    if (Platform.OS === 'web' || hasSyncedRef.current) return;
    hasSyncedRef.current = true;
    setSyncingContacts(true);
    syncContacts(false, t).then(result => {
      const pc = result.chatyContacts || [];
      const oc = result.otherContacts || [];
      if (result.error === 'consent_denied' || result.error === 'permission_denied') setContactsAccess('denied');
      else if (!result.error) { setContactsAccess('granted'); lastContactSyncRef.current = Date.now(); }
      setPhoneContacts(pc);
      setOtherContacts(oc);
      try { setCache(CK_PHONE, pc, CK_TTL); setCache(CK_OTHER, oc, CK_TTL); } catch {}
    }).catch(() => {}).finally(() => setSyncingContacts(false));
  }, [t]);

  // [2026-10-09 find-contacts] Background re-sync (WhatsApp parity): when the
  // user adds someone in the system Contacts app and comes back, or the agenda
  // changes while this screen is open, refresh "Contatos no Chatyy" silently —
  // never re-prompting consent/permission (silent mode bails if not granted).
  const silentContactSync = useCallback((minGapMs = 0) => {
    if (Platform.OS === 'web' || pickMode) return;
    if (silentSyncBusyRef.current) return;
    if (minGapMs && Date.now() - lastContactSyncRef.current < minGapMs) return;
    silentSyncBusyRef.current = true;
    syncContacts(true, t, { silent: true }).then(result => {
      if (result?.error) return; // keep what is on screen
      const pc = result.chatyContacts || [];
      const oc = result.otherContacts || [];
      lastContactSyncRef.current = Date.now();
      setContactsAccess('granted');
      setPhoneContacts(pc);
      setOtherContacts(oc);
      try { setCache(CK_PHONE, pc, CK_TTL); setCache(CK_OTHER, oc, CK_TTL); } catch {}
    }).catch(() => {}).finally(() => { silentSyncBusyRef.current = false; });
  }, [t, pickMode]);

  useEffect(() => {
    if (Platform.OS === 'web' || pickMode) return;
    let debounce = null;
    const unsubContacts = subscribeContactsChanged(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => silentContactSync(0), 1500);
    });
    const appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active') silentContactSync(2 * 60 * 1000);
    });
    return () => {
      clearTimeout(debounce);
      try { unsubContacts(); } catch {}
      try { appSub?.remove?.(); } catch {}
    };
  }, [silentContactSync, pickMode]);

  // Manual refresh
  const doContactSync = useCallback(() => {
    if (Platform.OS === 'web') return;
    setSyncingContacts(true);
    syncContacts(true, t).then(result => {
      const pc = result.chatyContacts || [];
      const oc = result.otherContacts || [];
      setPhoneContacts(pc);
      setOtherContacts(oc);
      try { setCache(CK_PHONE, pc, CK_TTL); setCache(CK_OTHER, oc, CK_TTL); } catch {}
      if (result.error === 'consent_denied' || result.error === 'permission_denied') setContactsAccess('denied');
      else if (!result.error) { setContactsAccess('granted'); lastContactSyncRef.current = Date.now(); }
      if (result.error === 'permission_denied') {
        Alert.alert(
          t('chat.contactPermissionDeniedTitle') || 'Permissão negada',
          t('chat.contactPermissionDeniedMsg') || 'Pra encontrar seus amigos no Chatyy, abra os Ajustes do dispositivo → Chatyy → Contatos e habilite o acesso.',
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            // [bug 2026-10-05 android-dead-end] openURL('app-settings:') is an
            // iOS-only scheme — on Android it threw/failed silently and the user
            // was stuck. Linking.openSettings() opens the app's settings page on
            // both platforms.
            { text: t('chat.openSettings') || 'Abrir Ajustes', onPress: () => { try { require('react-native').Linking.openSettings(); } catch {} } },
          ]
        );
      } else if (result.error === 'consent_denied') {
        // [2026-10-07 discovery] User tapped "Agora não" — respect it silently
        // (was surfaced as a raw "Erro consent_denied").
      } else if (result.error) {
        // [2026-10-07 discovery] pt-BR copy instead of raw codes
        // ("module_unavailable: …", "sync_failed", "api_failed").
        Alert.alert(
          t('common.error') || 'Erro',
          t('chat.contactSyncFailed') || 'Não foi possível sincronizar seus contatos agora. Verifique sua conexão e tente de novo.'
        );
      } else if ((result.chatyContacts || []).length === 0 && (result.otherContacts || []).length === 0) {
        Alert.alert(t('chat.noContacts') || 'Sem contatos', t('chat.noContactsMsg') || 'Nenhum contato com email ou telefone foi encontrado no seu celular.');
      }
    }).catch((e) => {
      Alert.alert('Erro', String(e?.message || e));
    }).finally(() => setSyncingContacts(false));
  }, [t]);

  // Load recent contacts (from chat_list - direct conversations).
  // In pickMode (adding members to a group) we pull EVERY direct convo so
  // someone the user hasn't chatted with in weeks (eg sara.costa) still
  // appears in the picker. The standard New-Chat flow trims to 10 to keep
  // the suggestions row tight.
  useEffect(() => {
    setLoadingRecents(true);
    api.chatConversations().then(r => {
      if (r.success && r.data) {
        const convs = Array.isArray(r.data) ? r.data : (r.data.conversations || []);
        const allDirects = convs
          .filter(c => c.type === 'direct')
          .sort((a, b) => {
            const ta = new Date(b.last_message_at || b.updated_at || 0).getTime();
            const tb = new Date(a.last_message_at || a.updated_at || 0).getTime();
            return ta - tb;
          });
        const directs = pickMode ? allDirects : allDirects.filter(c => c.last_message_at).slice(0, 10);

        const meLc = (user?.email || '').toLowerCase();
        const recents = directs.map(c => {
          // For direct chats, extract the other person's info
          const members = c.members || [];
          const other = members.find(m => (m?.email || '').toLowerCase() !== meLc) || {};
          return {
            email: other.email || c.email || '',
            name: other.name || c.name || c.email || '',
            conversationId: c.id || c.conversation_id,
            lastMessage: c.last_message || '',
            lastMessageAt: c.last_message_at || '',
            isRegistered: true,
          };
        }).filter(r => r.email);

        setRecentContacts(recents);
        try { setCache(CK_REC, recents, CK_TTL); } catch {}
      }
    }).catch(() => {}).finally(() => setLoadingRecents(false));
  }, [user?.email]);

  // Load Chatyy directory users — on web always, on native ONLY in pickMode
  // (adding members to a group). Without this branch a user adding members
  // to a group on iOS would only see contacts from their phone book + their
  // 10 most-recent direct chats — old conversations like sara.costa fall
  // off the list. WhatsApp's "Add Participant" picker shows every Chatyy
  // user, which is what pickMode now mirrors.
  useEffect(() => {
    const shouldLoad = Platform.OS === 'web' || pickMode;
    if (!shouldLoad) { setLoadingDirectory(false); return; }
    setLoadingDirectory(true);
    api.chatyyUsers('', 200).then(r => {
      if (r.success) {
        const users = (r.data?.users || []).filter(u => u.email !== user?.email)
          .map(u => ({ ...u, isRegistered: true }));
        setDirectoryUsers(users);
        try { setCache(CK_DIR, users, CK_TTL); } catch {}
      }
    }).catch(() => {}).finally(() => setLoadingDirectory(false));
  }, [user?.email, pickMode]);

  // "Pessoas que você pode conhecer" — combina sinais do backend:
  // amigos-de-amigos (chat_follows), co-membros de grupo e matches por número
  // de telefone (quem eu já procurei via chat_sync_contacts + quem acabou de
  // entrar no Chatyy). Server-side filtra quem já está nas minhas conversas
  // e quem está bloqueado em qualquer direção.
  const refreshSuggestions = useCallback(() => {
    if (!user?.email) return;
    api.chatFriendSuggestions?.({ limit: 8 }).then(r => {
      if (r?.success) {
        const items = (r.data?.suggestions || []).map(s => ({
          email: s.email,
          name: s.name,
          isRegistered: true,
          _suggested: true,
          _sources: s.sources || [],
          _justJoined: !!s._justJoined,
        }));
        setSuggestions(items);
        try { setCache(CK_SUG, items, CK_TTL); } catch {}
      }
    }).catch(() => {});
  }, [user?.email]);

  useEffect(() => { refreshSuggestions(); }, [refreshSuggestions]);

  // Real-time "X entrou no Chatyy": a previously-searched contact just
  // registered — pop them straight into the suggestions list with a
  // "Novo no Chatyy" flag and refresh the scored list in the background.
  useEffect(() => {
    if (!user?.email) return;
    let alive = true;
    let unsub = null;
    try {
      const mailWs = require('../services/websocket').default;
      const handler = (payload) => {
        if (!alive) return;
        const email = (payload?.email || '').toLowerCase();
        if (!email || email === String(user.email || '').toLowerCase()) return;
        setSuggestions(prev => {
          if (prev.some(s => String(s.email || '').toLowerCase() === email)) return prev;
          return [
            {
              email,
              name: payload?.name || email.split('@')[0],
              isRegistered: true,
              _suggested: true,
              _sources: ['contact'],
              _justJoined: true,
            },
            ...prev,
          ].slice(0, 10);
        });
        // Re-score + sort against fresh server state shortly after (debounced).
        setTimeout(() => { if (alive) refreshSuggestions(); }, 1500);
      };
      if (typeof mailWs.on === 'function') {
        mailWs.on('contact_joined', handler);
        unsub = () => { try { mailWs.off?.('contact_joined', handler); } catch {} };
      }
    } catch {}
    return () => { alive = false; if (unsub) unsub(); };
  }, [user?.email, refreshSuggestions]);

  // ---- Public channel discovery (Telegram-style) ----
  // Hard-coded categories in pt-BR; no new i18n keys per task constraint —
  // all labels use t() with inline fallback so existing locales still work.
  const DISCOVER_CATEGORIES = useMemo(() => ([
    { key: 'all',      label: t('chat.discoverAll')      || 'Tudo' },
    { key: 'news',     label: t('chat.discoverNews')     || 'Notícias' },
    { key: 'tech',     label: t('chat.discoverTech')     || 'Tech' },
    { key: 'sports',   label: t('chat.discoverSports')   || 'Esportes' },
    { key: 'music',    label: t('chat.discoverMusic')    || 'Música' },
    { key: 'business', label: t('chat.discoverBusiness') || 'Negócios' },
    { key: 'other',    label: t('chat.discoverOther')    || 'Outros' },
  ]), [t]);

  const loadPublicChannels = useCallback((category = 'all', q = '') => {
    if (!api.chatDiscoverPublic) { setPublicChannels([]); return; }
    const opts = { sort: 'members_desc' };
    if (category && category !== 'all') opts.category = category;
    if (q && q.trim()) opts.q = q.trim();
    api.chatDiscoverPublic(opts).then(r => {
      if (r?.success) {
        const list = r.data?.channels || [];
        setPublicChannels(list);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => { loadPublicChannels(discoverCategory, ''); }, [discoverCategory, loadPublicChannels]);

  // Broadcast lists loader — pulls the user's saved chat_broadcast_lists.
  // Skipped in pickMode (member-add flow) where the section is hidden.
  // Silent-failure: empty list collapses the section without a toast.
  const loadBroadcastLists = useCallback(() => {
    if (pickMode) return;
    if (!api.chatBroadcastList) return;
    api.chatBroadcastList().then(r => {
      if (r?.success) {
        const lists = (r.data?.lists || r.data?.items || []).map(l => {
          // recipients arrives either as a JSON-encoded string (legacy)
          // or as a parsed array — normalize so renderers don't have to.
          let recipients = l.recipients;
          if (typeof recipients === 'string') {
            try { recipients = JSON.parse(recipients); } catch { recipients = []; }
          }
          return { ...l, recipients: Array.isArray(recipients) ? recipients : [] };
        });
        setBroadcastLists(lists);
      }
    }).catch(() => {});
  }, [pickMode]);
  useEffect(() => { loadBroadcastLists(); }, [loadBroadcastLists]);

  // Trending hashtags loader — runs once on mount (and when discoverCategory
  // toggles, since the discovery surface is the entry point and we want
  // fresh tags whenever the user lands here). Failure is silent: empty list
  // just hides the row without a console-noise error.
  useEffect(() => {
    if (!api.chatHashtagTrending) return;
    let cancelled = false;
    api.chatHashtagTrending(20).then(r => {
      if (cancelled) return;
      if (r?.success && Array.isArray(r.data?.tags)) {
        setTrendingTags(r.data.tags);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleOpenHashtag = useCallback((tag) => {
    const bare = String(tag || '').replace(/^#/, '').trim();
    if (!bare) return;
    try {
      router.push({ pathname: '/hashtag/[tag]', params: { tag: bare } });
    } catch {}
  }, [router]);

  const handleJoinChannel = useCallback(async (channel) => {
    if (!channel?.id) return;
    if (joiningChannelId) return;
    setJoiningChannelId(channel.id);
    try {
      const r = await api.chatChannelJoin(Number(channel.id));
      if (r?.success) {
        const cid = r.data?.conversation_id || channel.id;
        router.replace({
          pathname: '/chat-conversation',
          params: { id: String(cid), name: channel.name || '', type: channel.type || 'channel' },
        });
      } else {
        safeAlert(t('common.error') || 'Erro', r?.message || 'Falha ao entrar no canal');
      }
    } catch (e) {
      safeAlert(t('common.error') || 'Erro', String(e?.message || e));
    } finally {
      setJoiningChannelId(null);
    }
  }, [joiningChannelId, router, t]);

  // Open the channel preview (read-only / direct entry — same screen).
  // The chat-conversation screen handles preview vs. member view.
  const handleOpenChannel = useCallback((channel) => {
    if (!channel?.id) return;
    router.push({
      pathname: '/chat-conversation',
      params: { id: String(channel.id), name: channel.name || '', type: channel.type || 'channel' },
    });
  }, [router]);

  // Merge contacts for display list
  // WhatsApp-like: on native, ONLY show phone contacts that matched + recent chats.
  // On web (no phone access), show directory users as fallback.
  const allChatyyUsers = useMemo(() => {
    const merged = new Map();
    // Always include recent chat contacts (people you've already talked to)
    for (const r of recentContacts) {
      if (r.email) merged.set(r.email, { ...r, hasRecentChat: true });
    }
    // Include phone contacts that are on Chatyy (matched by phone sync)
    for (const p of phoneContacts) {
      if (p.email && !merged.has(p.email)) {
        merged.set(p.email, { ...p, isRegistered: true, isPhoneContact: true });
      } else if (p.email && merged.has(p.email)) {
        const existing = merged.get(p.email);
        merged.set(p.email, { ...existing, name: p.name || existing.name, isPhoneContact: true });
      }
    }
    // On WEB always, and on native in pickMode: include the directory list so
    // every Chatyy user shows up. Otherwise the iOS "Add to group" picker
    // missed users the admin chatted with months ago (their direct convo
    // was past the recent-10 slice and phone contacts only cover names that
    // also live in the address book).
    if (Platform.OS === 'web' || pickMode) {
      for (const d of directoryUsers) {
        if (d.email && !merged.has(d.email)) {
          merged.set(d.email, { ...d, isRegistered: true });
        }
      }
    }
    const arr = Array.from(merged.values());
    arr.sort((a, b) => {
      if (a.hasRecentChat && !b.hasRecentChat) return -1;
      if (!a.hasRecentChat && b.hasRecentChat) return 1;
      return (a.name || a.email || '').localeCompare(b.name || b.email || '');
    });
    return arr;
  }, [recentContacts, phoneContacts, directoryUsers, pickMode]);

  // Build sections - MUST be declared before handleAlphabetPress
  // WhatsApp parity (print 7175):
  //   - "Message yourself" pinned at the top of the on-Chatyy bucket
  //   - Contacts grouped A-Z (each letter is its own section so the
  //     sticky header doubles as the alphabet-jump target)
  //   - Invite section at the bottom; tapping a row opens the OS share
  //     sheet so the user can pick SMS / WhatsApp / etc.
  const buildSections = useCallback(() => {
    const sections = [];
    // Suggestions section — curated top-N by the backend (friends-of-friends,
    // group co-members, phone contacts). On web the main directory list is
    // alphabetical across all registered users, so a person may appear in
    // both sections — that's fine (Facebook/LinkedIn work the same way).
    // [2026-10-09 find-contacts] "Contatos no Chatyy" (my agenda) comes FIRST
    // when the phone book is connected; suggestions move right after it.
    const suggestionsSection = suggestions.length > 0 ? {
      key: 'suggestions',
      title: t('chat.peopleYouMayKnow') || 'Pessoas que você pode conhecer',
      data: suggestions,
    } : null;
    if (suggestionsSection && phoneContacts.length === 0) {
      sections.push({
        key: 'suggestions',
        title: t('chat.peopleYouMayKnow') || 'Pessoas que você pode conhecer',
        data: suggestions,
      });
    }
    // "Message yourself" — pinned top entry into the on-Chatyy bucket.
    // Mirrors WhatsApp's "(You) - Message yourself" row at the top of
    // the contacts list. Tapping it opens the Saved Messages thread
    // (chat with self) via the existing chatSaved endpoint. Hidden in
    // pickMode (adding someone else to a group, doesn't make sense).
    const onChatyyBucket = [];
    if (!pickMode && user?.email) {
      onChatyyBucket.push({
        _isMessageYourself: true,
        email: user.email,
        name: user.name || (user.email || '').split('@')[0],
        isRegistered: true,
      });
    }
    // WhatsApp parity: "Contacts on Chatyy" = contacts from MY phone book
    // who are registered, not the global directory. This is what users
    // expect when scanning the section header. We now bucket them under
    // A-Z sub-sections so the AlphabetSidebar can jump precisely to a letter.
    if (phoneContacts.length > 0) {
      // Sort A-Z by name (or email username when name missing)
      const sorted = [...phoneContacts].sort((a, b) => {
        const an = (a.name || a.email || '').toLowerCase();
        const bn = (b.name || b.email || '').toLowerCase();
        return an.localeCompare(bn);
      });
      // First section keeps the "Contacts on Chatyy (N)" hero header +
      // the pinned "Message yourself" row + every contact whose first
      // letter is non-alphabetic (numbers/emojis etc.). This way the
      // count chip + Saved Messages stay anchored at the top.
      const buckets = new Map(); // letter -> array
      const nonAlpha = [];
      for (const c of sorted) {
        const first = ((c.name || c.email || '?')[0] || '?').toUpperCase();
        if (first >= 'A' && first <= 'Z') {
          if (!buckets.has(first)) buckets.set(first, []);
          buckets.get(first).push(c);
        } else {
          nonAlpha.push(c);
        }
      }
      // Hero section: "Contacts on Chatyy (N)" + "Message yourself" + non-alpha rest
      sections.push({
        key: 'phone_chatyy',
        title: `${t('chat.contactsOnChatyy')} (${phoneContacts.length})`,
        data: [...onChatyyBucket, ...nonAlpha],
      });
      // Letter sub-sections — sticky headers act as A, B, C, ... jump points.
      const letters = Array.from(buckets.keys()).sort();
      for (const letter of letters) {
        sections.push({
          key: `phone_chatyy_${letter}`,
          title: letter,
          data: buckets.get(letter),
          _letterBucket: true,
        });
      }
    } else if (onChatyyBucket.length > 0) {
      // No phone contacts matched, but still show Message yourself at top.
      sections.push({
        key: 'phone_chatyy',
        title: t('chat.contactsOnChatyy'),
        data: onChatyyBucket,
      });
    }
    if (suggestionsSection && phoneContacts.length > 0) sections.push(suggestionsSection);
    // Then show the broader directory under a separate header so users can
    // still browse Chatyy beyond their own phone book.
    const directoryRest = phoneContacts.length > 0
      ? allChatyyUsers.filter(u => !phoneContacts.some(p => (p.email || '').toLowerCase() === (u.email || '').toLowerCase()))
      : allChatyyUsers;
    if (directoryRest.length > 0) {
      sections.push({
        key: 'chatyy',
        title: `${t('chat.directoryOnChatyy') || t('chat.contactsOnChatyy')} (${directoryRest.length})`,
        data: directoryRest,
      });
    }
    if (otherContacts.length > 0) {
      sections.push({
        key: 'invite',
        title: `${t('chat.inviteToChatyy')} (${otherContacts.length})`,
        data: otherContacts.slice(0, 50),
      });
    } else if (Platform.OS === 'web') {
      // On web we can't access phone contacts, show a placeholder invite section
      sections.push({
        key: 'invite',
        title: t('chat.inviteToChatyy'),
        data: [{ _isInvitePlaceholder: true }],
      });
    }
    return sections;
  }, [allChatyyUsers, otherContacts, phoneContacts, suggestions, pickMode, user?.email, user?.name, t]);

  // Memoize the built sections so the A-Z sort + bucketing only runs when its
  // real inputs change (contacts/suggestions/pickMode/user/t) — NOT on every
  // render or keystroke. `buildSections` is a useCallback whose deps already
  // capture those inputs, so depending on its identity is exact. This is the
  // core fix for the picker jank (was re-sorting on every setSearchText).
  const sections = useMemo(() => buildSections(), [buildSections]);

  // Volatile per-row inputs bundled for the list's `extraData`. Now that
  // `sections` is a stable memo, the list no longer gets a fresh `sections`
  // reference on selection/typing — so we must tell it when a visible cell's
  // derived state (checkbox selection, invite spinner, highlight, mode)
  // changed. The memoized ContactRow still skips rows whose own props are
  // unchanged, so this only re-renders the cells that actually differ.
  const listExtraData = useMemo(
    () => ({ selectedMembers, invitingEmail, mode, searchText, colors }),
    [selectedMembers, invitingEmail, mode, searchText, colors]
  );

  // [2026-10-07 discovery] Unified people search (WhatsApp/Telegram parity).
  // ONE server call (people_search) replaces the old fan-out of chatyy_users +
  // contacts (IMAP Sent scan) + search_by_username (did not exist → 400) +
  // find_by_phone. Instant local pass first (accent-insensitive) over people I
  // already know (agenda + conversas), then the ranked server sections:
  //   "Seus contatos" → "No Chatyy" → "Convidar para o Chatyy" (agenda
  //   non-users + phone number not on Chatyy). Stale responses are dropped
  //   via a sequence counter so fast typing never shows an older result.
  const searchSeqRef = useRef(0);
  const handleSearch = useCallback((text) => {
    setSearchText(text);
    clearTimeout(searchTimeout.current);
    const seq = ++searchSeqRef.current;
    const raw = String(text || '').trim();
    if (!raw) {
      setSearchResults([]);
      setSearchChannelResults([]);
      setSearching(false);
      return;
    }

    const isUsernameSearch = raw.startsWith('@');
    const qf = foldSearchText(isUsernameSearch ? raw.slice(1) : raw).replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim();
    const qParts = qf.split(' ').filter(Boolean);
    const qDigits = raw.replace(/\D/g, '');
    const looksLikePhone = qDigits.length >= 8 && qDigits.length <= 15 && qDigits.length === raw.replace(/[\s+()\-./\u2010-\u2015\u2212\u00A0\u2007\u202F\u2060\uFEFF]/g, '').length; // [2026-10-09] iOS copia com hífen Unicode (U+2011)
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw);

    const fieldsOf = (u) => {
      const email = String(u.email || '').toLowerCase();
      const local = email.split('@')[0];
      return {
        name: foldSearchText(u.name || '').replace(/[.\-_]/g, ' '),
        local: local.replace(/[.\-_]/g, ' '),
        email,
        handle: String(u.username || '').toLowerCase(),
        phone: String(u.phone || '').replace(/\D/g, ''),
      };
    };
    const matchLocal = (u) => {
      const f = fieldsOf(u);
      if (isUsernameSearch) {
        const h = qf.replace(/ /g, '');
        return !!h && (f.handle.startsWith(h) || f.local.replace(/ /g, '').startsWith(h));
      }
      if (looksLikePhone) {
        // last 8 digits are stable across +55 / 0 / 9th-digit variants
        const tail = qDigits.slice(-8);
        return !!f.phone && f.phone.endsWith(tail);
      }
      if (raw.includes('@')) return f.email.startsWith(raw.toLowerCase());
      const hay = `${f.name} ${f.local} ${f.handle}`;
      if (!qParts.length) return false;
      // every query word must START a word in name/handle/local (WhatsApp-like)
      const words = hay.split(' ').filter(Boolean);
      return qParts.every(p => words.some(w => w.startsWith(p))) || (qf.length >= 3 && hay.includes(qf));
    };

    const localContacts = allChatyyUsers.filter(matchLocal).map(u => ({ ...u, isRegistered: true, _localHit: true }));
    const localInvites = (otherContacts || []).filter(matchLocal).slice(0, 20).map(c => ({ ...c, isRegistered: false }));

    // Header rows are rendered by ContactRow (_isSearchHeader).
    const hdr = (key, title) => ({ _isSearchHeader: true, _key: `hdr_${key}`, title });
    const compose = (serverContacts, serverGlobal, phoneInvite) => {
      const seen = new Set();
      const take = (arr) => arr.filter(u => {
        const k = String(u.email || '').toLowerCase();
        if (!k || seen.has(k) || k === String(user?.email || '').toLowerCase()) return false;
        seen.add(k);
        return true;
      });
      // Exact identifier hits (phone / @handle / e-mail) jump to the very top.
      const exact = take([...serverContacts, ...serverGlobal].filter(u => (u.score || 0) >= 950)
        .map(u => ({ ...u, isRegistered: true })));
      const mine = take([...localContacts, ...serverContacts.map(u => ({ ...u, isRegistered: true }))]);
      const global = take(serverGlobal.map(u => ({ ...u, isRegistered: true })));
      const out = [];
      if (exact.length) out.push(hdr('exact', t('chat.searchBestMatch') || 'Melhor resultado'), ...exact);
      if (mine.length) out.push(hdr('mine', t('chat.searchYourContacts') || 'Seus contatos'), ...mine);
      if (global.length) out.push(hdr('global', t('chat.searchOnChatyy') || 'No Chatyy'), ...global);
      const invites = [...localInvites];
      if (phoneInvite && !exact.length && !mine.length && !global.length) {
        // [2026-10-09 find-contacts] Clear verdict first ("Ninguém com esse
        // número no Chatyy") + invite row with the formatted number.
        out.push(hdr('nobody', t('chat.searchNoOneWithNumber')));
        out.push({ _isPhoneInvite: true, _key: `inv_${phoneInvite.e164}`, phone: phoneInvite.e164, name: phoneInvite.display || phoneInvite.e164, display: phoneInvite.display });
      }
      if (invites.length) out.push(hdr('invite', t('chat.inviteToChatyy')), ...invites);
      return out;
    };

    const firstPaint = compose([], [], null);
    setSearchResults(firstPaint);

    const serverWorthy = isUsernameSearch || looksLikePhone || looksLikeEmail || qf.length >= 2;
    if (!serverWorthy) { setSearching(false); setSearchChannelResults([]); return; }
    // Spinner only when there is nothing local to show yet.
    setSearching(firstPaint.length === 0);

    searchTimeout.current = setTimeout(async () => {
      // Public channels (Telegram "global search" extension) — names only.
      if (!looksLikePhone && !looksLikeEmail && api.chatDiscoverPublic) {
        api.chatDiscoverPublic({ q: raw, sort: 'members_desc' }).then(r => {
          if (seq !== searchSeqRef.current) return;
          setSearchChannelResults(r?.success ? (r.data?.channels || []) : []);
        }).catch(() => { if (seq === searchSeqRef.current) setSearchChannelResults([]); });
      } else {
        setSearchChannelResults([]);
      }
      try {
        let homeDial = '';
        try { homeDial = getHomeDialDigits(); } catch {}
        const r = await api.peopleSearch(raw, homeDial);
        if (seq !== searchSeqRef.current) return; // a newer keystroke won
        if (r?.success) {
          const d = r.data || {};
          setSearchResults(compose(d.contacts || [], d.global || [], d.invite || null));
        } else if (r?.message && /muitas/i.test(r.message)) {
          // 429 — keep local results, tell the user calmly (pt-BR from server).
          setSearchResults([...compose([], [], null), { _isSearchHeader: true, _key: 'hdr_rl', title: r.message }]);
        } else {
          // [2026-10-09 find-contacts] Server error: keep local results and say
          // so — never the misleading "ninguém com esse número" empty state.
          setSearchResults([...compose([], [], null), { _isSearchHeader: true, _key: 'hdr_err', title: t('chat.searchServerFailed') }]);
        }
      } catch {
        // network error: keep the local results already painted + calm note
        if (seq === searchSeqRef.current) {
          setSearchResults([...compose([], [], null), { _isSearchHeader: true, _key: 'hdr_err', title: t('chat.searchServerFailed') }]);
        }
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    }, 280);
  }, [user?.email, allChatyyUsers, otherContacts, t]);

  const handleSelectContact = (contact) => {
    // Pick-mode: adding this contact to an existing group. One-tap flow —
    // hit chatAddMember, toast, navigate back into the conversation.
    if (pickMode && addMemberConvId && contact?.email) {
      (async () => {
        try {
          const r = await api.chatAddMember(addMemberConvId, contact.email);
          if (r?.success) {
            // Restore type+name on the way back — replacing with only `id`
            // remounted the group as type='direct' (chat-conversation falls
            // back to 'direct' when params.type is absent). 'group' fallback:
            // pick-mode only ever starts from the group/channel info modal.
            router.replace({ pathname: '/chat-conversation', params: { id: String(addMemberConvId), type: pageParams.addMemberConvType || 'group', name: pageParams.addMemberConvName || '' } });
          } else {
            safeAlert(t('common.error') || 'Erro', r?.message || 'Falha ao adicionar');
          }
        } catch (e) {
          safeAlert(t('common.error') || 'Erro', String(e?.message || e));
        }
      })();
      return;
    }
    if (mode === 'direct') {
      handleCreateDirect(contact.email, contact.name || contact.email);
      return;
    }
    setSelectedMembers(prev => {
      const exists = prev.find(m => m.email === contact.email);
      if (exists) return prev.filter(m => m.email !== contact.email);
      return [...prev, { email: contact.email, name: contact.name || contact.email }];
    });
  };

  const handleCreateDirect = async (targetEmail, targetName) => {
    if (creating) return;
    // [2026-07-03 QA] Guard against contacts that carry no Chatyy email (e.g. a
    // phone-only suggestion). chatCreate([undefined/'']) → server 400. Surface a
    // clean message instead of a raw console error + spinner stuck.
    const em = String(targetEmail || '').trim().toLowerCase();
    if (!em || !em.includes('@')) {
      safeAlert(t('common.error') || 'Erro', t('chat.contactNotOnChatyy') || 'Este contato ainda não está no Chatyy.');
      return;
    }
    // [2026-07-04 QA] You can appear in your OWN friend suggestions — tapping
    // yourself must open "Saved Messages" (WhatsApp parity), NOT chat_create,
    // which the server correctly rejects with 400 "Cannot create a chat with
    // yourself" (chat.php:3007) → console error + stuck spinner.
    // [2026-07-12 QA] Prefer the MailContext/useAuth `user.email` — on WEB the
    // getActiveAccountEmail()/getSavedEmail() cache is empty (cookie session), so
    // the self-check missed and chat_create fired → server 400 "yourself" logged
    // to console (QA robot: click "AD Aleff" → 400). user.email is the same
    // source the suggestions list already filters self by (line ~304).
    const _me = String((user?.email || api.getActiveAccountEmail?.() || api.getSavedEmail?.() || '')).trim().toLowerCase();
    if (_me && em === _me) {
      try {
        const rs = await api.chatSaved();
        const sid = rs?.data?.id || rs?.data?.conversation_id;
        if (rs?.success && sid) {
          router.replace({ pathname: '/chat-conversation', params: { id: String(sid), name: t('chat.savedMessages') || 'Saved Messages' } });
        }
      } catch {}
      return;
    }
    setCreating(true);
    try {
      const r = await api.chatCreate([em], '', 'direct');
      const convId = r.data?.conversation_id || r.data?.id;
      const convName = r.data?.name || targetName;
      if (r.success && convId) {
        router.replace(`/chat-conversation?id=${convId}&name=${encodeURIComponent(convName)}&type=direct&email=${encodeURIComponent(em)}`);
      } else if (/yourself|voc[eê] mesmo|si mesmo/i.test(String(r?.message || ''))) {
        // [2026-07-04 QA] Belt-and-suspenders: server rejected a self-DM. On web the
        // pre-guard (getActiveAccountEmail) can be empty, so catch the 400 here and
        // open "Saved Messages" instead of surfacing a raw error.
        try {
          const rs = await api.chatSaved();
          const sid = rs?.data?.id || rs?.data?.conversation_id;
          if (rs?.success && sid) router.replace({ pathname: '/chat-conversation', params: { id: String(sid), name: t('chat.savedMessages') || 'Saved Messages' } });
        } catch {}
      } else {
        safeAlert(t('common.error'), r?.message || t('chat.createError'));
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally { setCreating(false); }
  };

  const handleCreateGroup = async () => {
    if (creating || selectedMembers.length === 0) return;
    const finalName = groupName.trim() || (selectedMembers.length > 1
      ? selectedMembers.slice(0, 3).map(m => (m.name || m.email).split('@')[0]).join(', ')
      : t('chat.group'));
    if (!groupName.trim() && selectedMembers.length > 1) {
      setGroupName(finalName);
    }
    setCreating(true);
    try {
      const members = selectedMembers.map(m => m.email);
      const r = await api.chatCreate(members, finalName, 'group');
      const convId = r.data?.conversation_id || r.data?.id;
      if (r.success && convId) {
        router.replace(`/chat-conversation?id=${convId}&name=${encodeURIComponent(r.data?.name || finalName)}&type=group`);
      } else {
        safeAlert(t('common.error'), r?.message || t('chat.createGroupError'));
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally { setCreating(false); }
  };

  const handleCreateChannel = async () => {
    if (creating || !groupName.trim()) return;
    setCreating(true);
    try {
      const r = await api.chatCreateChannel(groupName.trim(), '');
      const convId = r.data?.id;
      if (r.success && convId) {
        router.replace(`/chat-conversation?id=${convId}&name=${encodeURIComponent(groupName.trim())}&type=channel`);
      } else {
        safeAlert(t('common.error'), r?.message || 'Error');
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally { setCreating(false); }
  };

  const handleAddEmail = () => {
    const email = searchText.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      safeAlert(t('chat.invalidEmail'), t('chat.invalidEmailDesc'));
      return;
    }
    if (email === user?.email) return;
    if (mode === 'direct') {
      handleCreateDirect(email, email);
    } else {
      if (!selectedMembers.find(m => m.email === email)) {
        setSelectedMembers(prev => [...prev, { email, name: email.split('@')[0] }]);
      }
      setSearchText('');
      setSearchResults([]);
    }
  };

  // Invite handlers
  const handleInviteShare = async (contact) => {
    const name = contact?.name || '';
    const inviteMsg = `${name ? name + ', ' : ''}${t('chat.inviteShareMessage')}`;
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(inviteMsg);
        safeAlert('', t('chat.inviteCopied'));
      } catch {
        safeAlert('Chatyy', inviteMsg);
      }
      return;
    }
    try { await Share.share({ message: inviteMsg, title: 'Chatyy' }); } catch {}
  };

  const handleInviteByEmail = async (email, name = '') => {
    if (!email || !email.includes('@')) return;
    setInvitingEmail(email);
    try {
      const r = await api.sendInvite(email, name);
      if (r.success) {
        safeAlert('', t('chat.inviteSentTo', { email }));
      } else {
        safeAlert(t('common.error'), r.message || 'Failed');
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    }
    setInvitingEmail(null);
  };

  const handleInviteViaWhatsApp = (contact) => {
    const phone = contact.phone || '';
    const msg = encodeURIComponent(t('chat.inviteShareMessage'));
    const url = phone
      ? `https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`
      : `https://wa.me/?text=${msg}`;
    Linking.openURL(url).catch(() => {});
  };

  // [2026-10-07 discovery] Invite a typed phone number that is not on Chatyy:
  // SMS (native composer, prefilled), WhatsApp click-to-chat, or share sheet.
  // Android Alert renders at most 3 buttons → no explicit cancel (tap outside).
  const handleInvitePhone = (item) => {
    const digits = String(item?.phone || '').replace(/\D/g, '');
    if (!digits) return;
    const msg = t('chat.inviteShareMessage') || 'Baixe o Chatyy! Mensagens seguras e gratuitas. https://chatyy.com.br';
    const wa = `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
    if (Platform.OS === 'web') { Linking.openURL(wa).catch(() => {}); return; }
    const sms = Platform.OS === 'ios'
      ? `sms:+${digits}&body=${encodeURIComponent(msg)}`
      : `sms:+${digits}?body=${encodeURIComponent(msg)}`;
    Alert.alert(
      t('chat.invitePhone') || 'Convidar este número',
      item?.display || `+${digits}`,
      [
        { text: 'SMS', onPress: () => Linking.openURL(sms).catch(() => {}) },
        { text: 'WhatsApp', onPress: () => Linking.openURL(wa).catch(() => {}) },
        { text: t('chat.inviteShare') || 'Compartilhar', onPress: () => { Share.share({ message: msg }).catch(() => {}); } },
      ],
      { cancelable: true }
    );
  };

  const isSelected = (email) => selectedMembers.some(m => m.email === email);

  // QR code data — [2026-10-07 discovery] canonical chatyy://add-contact
  // payload shared with /profile-qr (was JSON only this screen understood).
  const qrData = buildContactQrPayload(user?.email || '', user?.name || user?.email?.split('@')[0] || '');
  const profileLink = buildProfileLink(user);

  // QR code handler
  const handleQrPress = () => {
    setShowQrModal(true);
    setQrMode('show');
    setQrScanned(false);
  };

  const handleQrScan = async () => {
    // On web, prompt for email input instead of camera scan
    if (Platform.OS === 'web') {
      const email = window.prompt(t('chat.qrEnterEmail'));
      if (email && email.includes('@')) {
        handleCreateDirect(email.trim(), email.trim());
      }
      setShowQrModal(false);
      return;
    }
    // Request camera permission if not granted
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        safeAlert(t('chat.qrCode'), t('chat.qrCameraPermission'));
        return;
      }
    }
    setQrScanned(false);
    setQrMode('scan');
  };

  // [2026-10-09 find-contacts] Shortcut "Escanear QR": open the modal straight
  // in scan mode (camera permission asked here, on tap).
  const handleOpenQrScanner = async () => {
    if (Platform.OS !== 'web') setShowQrModal(true);
    setQrScanned(false);
    setQrMode('show');
    await handleQrScan();
  };

  // [2026-10-09 find-contacts] Shortcut "Novo contato": system new-contact form
  // (prefilled with the typed number, if any). Afterwards re-sync silently so
  // the new person shows up under "Contatos no Chatyy" when they have an account.
  const handleNewContact = async () => {
    const q = String(searchText || '').trim();
    const qDigits = q.replace(/\D/g, '');
    const prefill = qDigits.length >= 8 && qDigits.length <= 15 ? q : '';
    const shown = await presentNewContactForm(prefill);
    if (!shown) {
      safeAlert(t('chat.findNewContact'), t('chat.findNewContactUnavailable'));
      return;
    }
    // iOS: the form is modal in-app → it resolved on dismiss, sync now.
    // Android: an external activity opened (resolves early) → zero the gap so
    // the AppState 'active' on return re-syncs (contacts listener also fires).
    lastContactSyncRef.current = 0;
    if (Platform.OS === 'ios') silentContactSync(0);
  };

  const handleBarCodeScanned = ({ data }) => {
    if (qrScanned) return;
    setQrScanned(true);
    // [2026-10-07 discovery] One tolerant parser: chatyy://add-contact (this
    // screen + /profile-qr), legacy JSON, /u/<handle> & /@handle links,
    // group invites /j/<token>, mailto:/bare e-mail.
    const parsed = parseContactQr(data);
    if (parsed?.kind === 'email') {
      setShowQrModal(false);
      handleCreateDirect(parsed.email, parsed.name || parsed.email);
      return;
    }
    if (parsed?.kind === 'group') {
      setShowQrModal(false);
      try { router.push(`/j/${parsed.token}`); } catch {}
      return;
    }
    if (parsed?.kind === 'profile') {
      setShowQrModal(false);
      try { router.push(`/u/${encodeURIComponent(parsed.slug)}`); } catch {}
      return;
    }
    safeAlert(t('chat.qrCode'), t('chat.qrInvalid'));
    // Allow scanning again after invalid QR
    setTimeout(() => setQrScanned(false), 2000);
  };

  // Share QR code as image
  // [2026-10-07 discovery] Share my profile LINK (works outside the app and
  // for non-users) instead of downloading a PNG from a third-party QR API.
  const handleShareQrImage = async () => {
    const shareText = `${t('chat.qrSharePrefix') || 'Fale comigo no Chatyy:'} ${profileLink}`;
    if (Platform.OS === 'web') {
      try { await navigator.clipboard.writeText(shareText); safeAlert('', t('chat.inviteCopied')); }
      catch { safeAlert('Chatyy', shareText); }
      return;
    }
    Share.share({ message: shareText, url: profileLink }).catch(() => {});
  };

  // Build alphabet index — prefer phone contacts (the WhatsApp-style
  // primary list with letter buckets); fall back to directory users on
  // web where the phone book isn't available.
  const alphabetLetters = useMemo(() => {
    const letterSet = new Set();
    const source = phoneContacts.length > 0 ? phoneContacts : allChatyyUsers;
    for (const u of source) {
      const first = ((u.name || u.email || '?')[0] || '?').toUpperCase();
      if (first >= 'A' && first <= 'Z') letterSet.add(first);
    }
    return Array.from(letterSet).sort();
  }, [phoneContacts, allChatyyUsers]);

  // Handle alphabet press - scroll to the matching letter bucket. When
  // phoneContacts power the sidebar (native), we hop directly to the
  // `phone_chatyy_X` sub-section the new bucket builder emits. On web
  // (no phone book), we fall back to the legacy "chatyy" directory
  // section and scan for the first user whose name starts with the
  // requested letter.
  const handleAlphabetPress = useCallback((letter) => {
    if (!sectionListRef.current) return;
    // Read the already-memoized sections instead of rebuilding (re-sorting)
    // the whole list on every alphabet tap.
    const built = sections;
    // Native: jump straight to phone_chatyy_<L> letter bucket.
    const letterSectionIdx = built.findIndex(s => s.key === `phone_chatyy_${letter}`);
    if (letterSectionIdx >= 0) {
      try {
        sectionListRef.current.scrollToLocation({
          sectionIndex: letterSectionIdx,
          itemIndex: 0,
          animated: true,
          viewOffset: 0,
        });
      } catch {}
      return;
    }
    // Web fallback: jump within the directory list.
    const chatyySection = built.find(s => s.key === 'chatyy');
    if (!chatyySection) return;
    const sectionIdx = built.indexOf(chatyySection);
    const itemIdx = chatyySection.data.findIndex(u => {
      const first = ((u.name || u.email || '?')[0] || '?').toUpperCase();
      return first >= letter;
    });
    if (itemIdx >= 0) {
      try {
        sectionListRef.current.scrollToLocation({
          sectionIndex: sectionIdx,
          itemIndex: itemIdx,
          animated: true,
          viewOffset: 40,
        });
      } catch {}
    }
  }, [sections]);

  // ---- Render public channel discovery card ----
  const renderChannelCard = (channel) => {
    const handleStr = channel.public_handle ? `@${channel.public_handle}` : '';
    const memberCount = Number(channel.member_count || 0);
    const memberLabel = (t('chat.memberCount') || '{n} membros').replace('{n}', String(memberCount));
    const desc = (channel.description || '').toString().trim();
    return (
      <View
        key={`channel-${channel.id}`}
        style={[sty.channelCard, { borderBottomColor: colors.border }]}
      >
        <TouchableOpacity
          onPress={() => handleOpenChannel(channel)}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', flex: 1, alignItems: 'center', gap: 12 }}
        >
          <AvatarCircle email={channel.public_handle || String(channel.id)} name={channel.name || handleStr} size={48} colors={colors} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[sty.contactName, { color: colors.text }]} numberOfLines={1}>
                {channel.name || handleStr}
              </Text>
              {handleStr ? (
                <Text style={{ fontSize: 12, color: colors.primary, fontWeight: '600' }} numberOfLines={1}>
                  {handleStr}
                </Text>
              ) : null}
            </View>
            <Text style={[sty.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
              {memberLabel}
            </Text>
            {desc ? (
              <Text style={[sty.contactAbout, { color: colors.textSecondary, fontStyle: 'normal' }]} numberOfLines={2}>
                {desc}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sty.inviteBtn, { backgroundColor: '#111111' }]}
          onPress={() => handleJoinChannel(channel)}
          disabled={joiningChannelId === channel.id}
          activeOpacity={0.7}
        >
          {joiningChannelId === channel.id ? (
            <ActivityIndicator size={14} color="#fff" />
          ) : (
            <Text style={sty.inviteBtnText}>{t('chat.join') || 'Entrar'}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  // ---- Render Descobrir canais block (header + chips + list) ----
  // ---- Tópicos populares (trending hashtags) horizontal chip row ----
  // Renders nothing when the trending list is empty — server returns []
  // when no hashtags have been used in public channels yet, so the UI
  // gracefully hides instead of showing an empty row.
  const renderTrendingTagsBlock = () => {
    if (!trendingTags || trendingTags.length === 0) return null;
    return (
      <View style={{ paddingTop: 6, paddingBottom: 8 }}>
        <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingBottom: 4 }]}>
          <View style={sty.sectionAccentLine} />
          <Text style={[sty.sectionTitle, { color: isDark ? '#F5F5F7' : '#111111' }]}>
            {t('chat.trendingTopicsTitle') || 'Tópicos populares'}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 8 }}
          style={{ flexGrow: 0 }}
        >
          {trendingTags.map((it, i) => {
            const tag = String(it.hashtag || '').replace(/^#/, '');
            if (!tag) return null;
            return (
              <TouchableOpacity
                key={'th_' + i + '_' + tag}
                onPress={() => handleOpenHashtag(tag)}
                style={[
                  sty.discoverChip,
                  { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7', borderColor: colors.border },
                ]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={'#' + tag}
              >
                <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>
                  {'#' + tag}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  const renderDiscoverBlock = (channels) => {
    if (!channels || channels.length === 0) return null;
    return (
      <View style={{ paddingTop: 4, paddingBottom: 8 }}>
        <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingBottom: 4 }]}>
          <View style={sty.sectionAccentLine} />
          <Text style={[sty.sectionTitle, { color: isDark ? '#F5F5F7' : '#111111' }]}>
            {t('chat.discoverChannelsTitle') || 'Descobrir canais'}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 8 }}
          style={{ flexGrow: 0, marginBottom: 6 }}
        >
          {DISCOVER_CATEGORIES.map(cat => {
            const active = discoverCategory === cat.key;
            return (
              <TouchableOpacity
                key={cat.key}
                onPress={() => setDiscoverCategory(cat.key)}
                style={[
                  sty.discoverChip,
                  active
                    ? { backgroundColor: '#111111', borderColor: '#111111' }
                    : { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7', borderColor: colors.border },
                ]}
                activeOpacity={0.7}
              >
                <Text style={{
                  color: active ? '#fff' : colors.textSecondary,
                  fontSize: 13,
                  fontWeight: '600',
                }}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <View>
          {channels.map(renderChannelCard)}
        </View>
      </View>
    );
  };

  // ---- Render recent contacts (horizontal scroll) ----
  const renderRecentItem = ({ item }) => (
    <TouchableOpacity
      style={sty.recentItem}
      onPress={() => handleSelectContact(item)}
      activeOpacity={0.7}
    >
      <View>
        <AvatarCircle email={item.email} name={item.name || item.email} size={56} colors={colors} />
        {item.online ? <View style={[sty.onlineDot, { borderColor: colors.background }]} /> : null}
      </View>
      <Text style={[sty.recentName, { color: colors.text }]} numberOfLines={1}>
        {((item.name && !item.name.includes('@')) ? item.name : prettifyHandle(item.email || item.name || '')).split(' ')[0]}
      </Text>
    </TouchableOpacity>
  );

  // "Message yourself" handler — opens (or creates) the Saved Messages
  // thread, which is the canonical "chat with self" surface. Reuses the
  // same chatSaved endpoint already wired up by the Quick Actions row.
  const handleMessageYourself = useCallback(async () => {
    try {
      const r = await api.chatSaved();
      if (r?.success && r.data?.id) {
        router.replace({
          pathname: '/chat-conversation',
          params: {
            id: String(r.data.id),
            name: t('chat.savedMessages') || 'Saved Messages',
          },
        });
      }
    } catch {}
  }, [router, t]);

  // Stable callback wrappers for the memoized ContactRow. We keep the latest
  // handler in a ref and expose an identity-stable function, so React.memo can
  // skip untouched rows (a fresh inline arrow every render would defeat it)
  // while still always invoking the current handler (no stale closures — the
  // ref is updated on each render below).
  const rowHandlersRef = useRef({});
  rowHandlersRef.current.select = handleSelectContact;
  rowHandlersRef.current.inviteByEmail = handleInviteByEmail;
  rowHandlersRef.current.inviteShare = handleInviteShare;
  rowHandlersRef.current.inviteWhatsApp = handleInviteViaWhatsApp;
  rowHandlersRef.current.invitePhone = handleInvitePhone;
  const onSelectRow = useCallback((c) => rowHandlersRef.current.select(c), []);
  const onInviteByEmailRow = useCallback((e, n) => rowHandlersRef.current.inviteByEmail(e, n), []);
  const onInviteShareRow = useCallback((c) => rowHandlersRef.current.inviteShare(c), []);
  const onInviteViaWhatsAppRow = useCallback((c) => rowHandlersRef.current.inviteWhatsApp(c), []);
  const onInvitePhoneRow = useCallback((c) => rowHandlersRef.current.invitePhone(c), []);

  // ---- Render contact row ----
  // Thin adapter: computes the per-row `selected` flag and hands the row its
  // props. The heavy markup + invite-pill logic now lives in the memoized
  // module-level ContactRow, so typing/scrolling no longer re-renders every cell.
  const renderContact = useCallback(({ item }) => {
    const selected = selectedMembers.some(m => m.email === item.email);
    return (
      <ContactRow
        item={item}
        colors={colors}
        searchText={searchText}
        mode={mode}
        selected={selected}
        invitingEmail={invitingEmail}
        t={t}
        onMessageYourself={handleMessageYourself}
        onSelect={onSelectRow}
        onInviteByEmail={onInviteByEmailRow}
        onInviteShare={onInviteShareRow}
        onInviteViaWhatsApp={onInviteViaWhatsAppRow}
        onShowInviteInput={setShowInviteInput}
        onInvitePhone={onInvitePhoneRow}
      />
    );
  }, [colors, searchText, mode, selectedMembers, invitingEmail, t, handleMessageYourself, onSelectRow, onInviteByEmailRow, onInviteShareRow, onInviteViaWhatsAppRow, onInvitePhoneRow]);

  // Section header renderer — hoisted to a stable useCallback (was an inline
  // arrow on the SectionList). Only depends on isDark.
  const renderSectionHeader = useCallback(({ section }) => {
    // Slim A-Z letter bucket — single letter, lighter background, smaller
    // padding so the on-Chatyy list breathes between letters.
    if (section._letterBucket) {
      return (
        <View style={[sty.letterHeader, { backgroundColor: isDark ? '#0d0d0d' : '#fafafc' }]}>
          <Text style={[sty.letterHeaderText, { color: isDark ? '#F5F5F7' : '#111111' }]}>
            {section.title}
          </Text>
        </View>
      );
    }
    return (
      <View style={[sty.sectionHeader, { backgroundColor: isDark ? '#111' : '#f8f8fa' }]}>
        <View style={sty.sectionAccentLine} />
        <Text style={[sty.sectionTitle, { color: isDark ? '#F5F5F7' : '#111111' }]}>{section.title}</Text>
      </View>
    );
  }, [isDark]);

  // sections and buildSections moved before handleSearch to avoid TDZ

  const isLoading = syncingContacts || (loadingRecents && loadingDirectory);
  // Subtle neutral header-button background — matches the white-header pass
  // used across chat.js / inbox.js (light tap target on a white bar).
  const headerBtnBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';

  return (
    <View style={[sty.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {/* [2026-10-07 app-feel-nav] Nativo: header do sistema (título anima com
          o push, back chevron nativo + swipe-back), ações QR/atualizar como
          bar buttons. Web mantém o header custom abaixo. */}
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          title: t('chat.newConversation'),
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Platform.OS === 'ios' ? 4 : 8 }}>
              <HeaderIconButton onPress={handleQrPress} accessibilityLabel={t('chat.qrCode')}>
                <IconQrCode size={22} color={colors.text} />
              </HeaderIconButton>
              <HeaderIconButton onPress={doContactSync} disabled={syncingContacts} accessibilityLabel={t('chat.refreshContacts')}>
                {syncingContacts ? (
                  <ActivityIndicator size="small" color={colors.textTertiary} />
                ) : (
                  <IconRefresh size={20} color={colors.text} />
                )}
              </HeaderIconButton>
            </View>
          ),
        })} />
      ) : (
      /* Header — WHITE / clean (WhatsApp 2026 redesign): surface bg, dark
          text + icons, hairline bottom border. Was a solid black bar that got
          missed in the white-header pass across the rest of the app. */
      <View style={[sty.header, {
        backgroundColor: colors.headerBgSolid,
        borderBottomColor: colors.headerBorder,
        borderBottomWidth: StyleSheet.hairlineWidth,
      }]}>
        <TouchableOpacity onPress={() => router.back()} style={[sty.headerBtn, { backgroundColor: headerBtnBg, borderRadius: 20 }]} accessibilityLabel={t('common.back') || 'Voltar'} accessibilityRole="button">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[sty.headerTitle, { color: colors.text }]}>{t('chat.newConversation')}</Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {/* QR Code button */}
          <TouchableOpacity
            onPress={handleQrPress}
            style={[sty.headerBtn, { backgroundColor: headerBtnBg, borderRadius: 20 }]}
            accessibilityLabel={t('chat.qrCode')}
            accessibilityRole="button"
          >
            <IconQrCode size={22} color={colors.text} />
          </TouchableOpacity>
          {/* Manual refresh button (native only) */}
          {Platform.OS !== 'web' && (
            <TouchableOpacity
              onPress={doContactSync}
              style={[sty.headerBtn, { backgroundColor: headerBtnBg, borderRadius: 20 }]}
              disabled={syncingContacts}
              accessibilityLabel={t('chat.refreshContacts')}
              accessibilityRole="button"
            >
              {syncingContacts ? (
                <ActivityIndicator size={18} color={colors.textTertiary} />
              ) : (
                <IconRefresh size={20} color={colors.text} />
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
      )}

      {/* Mode Toggle */}
      <View style={[sty.toggleRow, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
        <TouchableOpacity
          style={[sty.toggleBtn, mode === 'direct' && [sty.toggleBtnActive, { backgroundColor: '#111111' }]]}
          onPress={() => { setMode('direct'); setSelectedMembers([]); }}
        >
          <IconMessageSquare size={15} color={mode === 'direct' ? '#fff' : colors.textSecondary} />
          <Text style={[sty.toggleText, { color: mode === 'direct' ? '#fff' : colors.textSecondary }]}>
            {t('chat.direct')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sty.toggleBtn, mode === 'group' && [sty.toggleBtnActive, { backgroundColor: '#111111' }]]}
          onPress={() => setMode('group')}
        >
          <IconUsers size={15} color={mode === 'group' ? '#fff' : colors.textSecondary} />
          <Text style={[sty.toggleText, { color: mode === 'group' ? '#fff' : colors.textSecondary }]}>
            {t('chat.group')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sty.toggleBtn, mode === 'channel' && [sty.toggleBtnActive, { backgroundColor: '#111111' }]]}
          onPress={() => setMode('channel')}
        >
          <Text style={{ fontSize: 13, marginRight: 3, color: mode === 'channel' ? '#fff' : colors.textSecondary }}>{'#'}</Text>
          <Text style={[sty.toggleText, { color: mode === 'channel' ? '#fff' : colors.textSecondary }]}>
            {t('chat.channels') || 'Canal'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Group/Channel Name */}
      {(mode === 'group' || mode === 'channel') && (
        <View style={[sty.groupNameWrap, { borderBottomColor: colors.border }]}>
          <TextInput
            style={[sty.groupNameInput, { color: colors.text, borderColor: isDark ? '#333' : '#e0e0e0', backgroundColor: isDark ? '#1e1e1e' : '#f5f5f7' }]}
            placeholder={mode === 'channel' ? (t('chat.channelName') || 'Nome do canal') : t('chat.groupNamePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={groupName}
            onChangeText={setGroupName}
          />
        </View>
      )}

      {/* Selected Members — WhatsApp-style horizontal chip rail with
          avatars. Fixed height so the layout doesn't jump as you add
          / remove people; nativeID prevents duplicate renders of the
          same chip causing the overflow glitch on web. */}
      {(mode === 'group' || mode === 'channel') && selectedMembers.length > 0 && (
        <View style={[sty.selectedRow, { borderBottomColor: colors.border }]}>
          <FlatList
            horizontal
            data={selectedMembers}
            keyExtractor={(item) => item.email}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={sty.selectedList}
            style={{ flexGrow: 0, height: 84 }}
            renderItem={({ item }) => {
              const label = (item.name || '').trim() || (item.email || '').split('@')[0];
              return (
                <TouchableOpacity
                  style={sty.selectedChip}
                  onPress={() => setSelectedMembers(prev => prev.filter(m => m.email !== item.email))}
                  accessibilityLabel={`Remover ${label}`}
                  accessibilityRole="button"
                >
                  <View style={{ position: 'relative' }}>
                    <AvatarCircle email={item.email} name={label} size={52} />
                    <View style={sty.selectedChipClose}>
                      <IconX size={12} color="#fff" />
                    </View>
                  </View>
                  <Text style={[sty.selectedChipText, { color: colors.text }]} numberOfLines={1}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>
      )}

      {/* Search Input — animated brand focus border + clear button */}
      <Animated.View
        style={[
          sty.searchWrap,
          {
            backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7',
            borderWidth: 1.5,
            borderColor: searchBorderAnim.interpolate({
              inputRange: [0, 1],
              // [2026-10-07 app-feel-ui] native search fields (UISearchBar /
              // Material search) have NO focus ring — the black outline read as
              // a web form. Web keeps the brand focus border.
              outputRange: ['transparent', Platform.OS === 'web' ? '#111111' : 'transparent'],
            }),
          },
        ]}
      >
        <IconSearch size={18} color={searchFocused && Platform.OS === 'web' ? '#111111' : colors.textTertiary} />
        <TextInput
          style={[sty.searchInput, { color: colors.text }]}
          placeholder={t('chat.searchOrType')}
          placeholderTextColor={colors.textTertiary}
          value={searchText}
          onChangeText={handleSearch}
          onSubmitEditing={handleAddEmail}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          // autoFocus removed — sticky keyboard on Android: user couldn't
          // close it by tapping outside, blocked the comunidades/listas
          // visible below. WhatsApp/Telegram pattern: search input
          // available but only focused when the user taps it. Reported
          // 2026-05-12 print 3.
          keyboardType="default"
          autoCapitalize="none"
          // [fix 2026-10-01] autoCorrect/autoComplete OFF — on Android the IME
          // composing region, combined with the controlled value re-applying
          // while the JS thread is busy filtering, resets the cursor to 0 and
          // each char gets prepended → "letras de trás pra frente". Turning off
          // the composing region fixes the reversed typing.
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          returnKeyType="search"
          blurOnSubmit
        />
        {searchText ? (
          <TouchableOpacity
            onPress={() => { setSearchText(''); setSearchResults([]); }}
            style={sty.searchClearBtn}
            accessibilityLabel={t('common.clear') || 'Limpar'}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={sty.searchClearCircle}>
              <IconX size={12} color="#fff" />
            </View>
          </TouchableOpacity>
        ) : null}
      </Animated.View>

      {/* Content */}
      {isLoading && !searchText && recentContacts.length === 0 && phoneContacts.length === 0 && suggestions.length === 0 && directoryUsers.length === 0 ? (
        /* Tasteful skeleton instead of a blank white screen on cold open.
           With the cache-seed above this branch is skipped whenever we have
           anything to paint; it only runs on a true first-ever load. */
        <ListSkeleton count={9} />
      ) : searchText.length >= 1 ? (
        /* Search results */
        searching ? (
          <View style={sty.loaderWrap}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={searchResults}
            keyExtractor={(item, i) => item._key || (item.email ? `${item.email}` : '') || (item.phone ? `ph_${item.phone}` : '') || String(i)}
            renderItem={renderContact}
            extraData={listExtraData}
            removeClippedSubviews
            windowSize={10}
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={50}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListHeaderComponent={(searchChannelResults && searchChannelResults.length > 0)
              ? (
                <View style={{ paddingTop: 4, paddingBottom: 8 }}>
                  <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingBottom: 4 }]}>
                    <View style={sty.sectionAccentLine} />
                    <Text style={[sty.sectionTitle, { color: isDark ? '#F5F5F7' : '#111111' }]}>
                      {t('chat.discoverChannelsTitle') || 'Descobrir canais'}
                    </Text>
                  </View>
                  {searchChannelResults.map(renderChannelCard)}
                </View>
              )
              : null}
            contentContainerStyle={sty.contactList}
            ListEmptyComponent={(() => {
              // Phone-shaped query with no matches → this number isn't on Chatyy yet.
              // Offer to invite via SMS/WhatsApp/share directly from here.
              // [2026-10-09 find-contacts] Unicode dashes/spaces (iOS copy) count
              // as formatting, and the invite carries the formatted number.
              const rawQ = (searchText || '').trim();
              const digits = rawQ.replace(/\D/g, '');
              const isPhoneQuery = digits.length >= 8 && digits.length <= 15 &&
                digits.length === rawQ.replace(/[\s+()\-./\u2010-\u2015\u2212\u00A0\u2007\u202F\u2060\uFEFF]/g, '').length;
              const isEmailQuery = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawQ);
              let invE164 = '';
              let invDisplay = rawQ;
              if (isPhoneQuery) {
                let hd = '55';
                try { hd = getHomeDialDigits() || '55'; } catch {}
                const nt = digits.replace(/^0+/, '');
                if (rawQ.startsWith('+')) invE164 = digits;
                else if (rawQ.startsWith('00')) invE164 = digits.slice(2);
                else if (hd === '55' && (nt.length === 10 || nt.length === 11)) invE164 = '55' + nt;
                else if (hd === '55' && nt.length >= 12 && nt.startsWith('55')) invE164 = nt;
                else invE164 = (nt.startsWith(hd) ? '' : hd) + nt;
                const n = invE164.startsWith('55') ? invE164.slice(2) : '';
                if (n.length === 10 || n.length === 11) invDisplay = `+55 (${n.slice(0, 2)}) ${n.slice(2, n.length - 4)}-${n.slice(-4)}`;
                else invDisplay = `+${invE164}`;
              }
              return (
                <View style={sty.emptyResults}>
                  <IllustrationSearch size={148} color={colors.primary} style={{ opacity: 0.95, marginBottom: 8 }} />
                  <Text style={[sty.emptyTitle, { color: colors.text }]}>
                    {isPhoneQuery
                      ? t('chat.searchNoOneWithNumber')
                      : t('chat.searchNoOneFound')}
                  </Text>
                  <Text style={[sty.emptyText, { color: colors.textTertiary }]}>
                    {isPhoneQuery
                      ? t('chat.searchInviteNumberDesc', { number: invDisplay })
                      : t('chat.searchNoOneFoundHint')}
                  </Text>
                  {isPhoneQuery && (
                    <TouchableOpacity
                      style={[sty.emptyActionBtn, { backgroundColor: '#111111', marginTop: 16 }]}
                      onPress={() => handleInvitePhone({ phone: invE164, display: invDisplay })}
                      accessibilityRole="button"
                    >
                      <IconUserPlus size={16} color="#fff" />
                      <Text style={sty.emptyActionText}>
                        {t('chat.searchInviteNumberBtn', { number: invDisplay })}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {!isPhoneQuery && !isEmailQuery && (
                    <TouchableOpacity
                      style={[sty.emptyActionBtn, { backgroundColor: '#111111', marginTop: 16 }]}
                      onPress={() => handleInviteShare({})}
                      accessibilityRole="button"
                    >
                      <IconShare size={16} color="#fff" />
                      <Text style={sty.emptyActionText}>{t('chat.inviteToChatyy')}</Text>
                    </TouchableOpacity>
                  )}
                  {/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((searchText || '').trim()) && (
                    <View style={{ gap: 10, marginTop: 16, alignItems: 'center' }}>
                      {mode !== 'direct' && (
                        <TouchableOpacity
                          style={[sty.emptyActionBtn, { backgroundColor: colors.primary }]}
                          onPress={handleAddEmail}
                        >
                          <IconPlus size={16} color={colors.onPrimary || '#fff'} />
                          <Text style={[sty.emptyActionText, { color: colors.onPrimary }]}>{t('chat.addEmail', { email: searchText })}</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={[sty.emptyActionBtn, { backgroundColor: '#111111' }]}
                        onPress={() => handleInviteByEmail(searchText.trim())}
                      >
                        <IconUserPlus size={16} color="#fff" />
                        <Text style={sty.emptyActionText}>{t('chat.inviteEmail')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })()}
          />
        )
      ) : (
        /* Default view: recents + contacts + invite */
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1 }}>
            <SectionList
              ref={sectionListRef}
              sections={sections}
              keyExtractor={(item, idx) => item.email || item.phone || String(idx)}
              renderItem={renderContact}
              renderSectionHeader={renderSectionHeader}
              extraData={listExtraData}
              // [fix 2026-10-01] Match the search FlatList: on Android, without
              // persistTaps the first tap on a contact just dismisses the open
              // keyboard instead of selecting (the "two-tap / teclado quebrado"
              // symptom). persist-taps = single tap selects.
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              removeClippedSubviews
              windowSize={10}
              initialNumToRender={12}
              maxToRenderPerBatch={10}
              updateCellsBatchingPeriod={50}
              contentContainerStyle={sty.contactList}
              stickySectionHeadersEnabled
              ListHeaderComponent={
                <View>
                  {/* [2026-10-09 find-contacts] WhatsApp-style shortcuts at the
                      very top: Novo grupo · Novo contato · Escanear QR · Meu QR. */}
                  {mode === 'direct' && !pickMode && (
                    <View style={sty.shortcutRow}>
                      <ShortcutTile label={t('chat.newGroup')} colors={colors} isDark={isDark} onPress={() => { setSelectedMembers([]); setMode('group'); }}>
                        <IconUsers size={20} color="#fff" />
                      </ShortcutTile>
                      {Platform.OS !== 'web' && (
                        <ShortcutTile label={t('chat.findNewContact')} colors={colors} isDark={isDark} onPress={handleNewContact}>
                          <IconUserPlus size={20} color="#fff" />
                        </ShortcutTile>
                      )}
                      <ShortcutTile label={t('chat.findScanQr')} colors={colors} isDark={isDark} onPress={handleOpenQrScanner}>
                        <IconCamera size={20} color="#fff" />
                      </ShortcutTile>
                      <ShortcutTile label={t('chat.findMyQr')} colors={colors} isDark={isDark} onPress={handleQrPress}>
                        <IconQrCode size={20} color="#fff" />
                      </ShortcutTile>
                    </View>
                  )}

                  {/* [2026-10-09 find-contacts] Agenda not connected → explain + one
                      tap to connect (consent + OS prompt happen on tap, never
                      silently). Hidden once access is granted. */}
                  {Platform.OS !== 'web' && !pickMode && contactsAccess === 'denied' && phoneContacts.length === 0 && !syncingContacts && (
                    <View style={[sty.findCta, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
                      <Text style={[sty.findCtaTitle, { color: colors.text }]}>{t('chat.findContactsCtaTitle')}</Text>
                      <Text style={[sty.findCtaDesc, { color: colors.textSecondary }]}>{t('chat.findContactsCtaDesc')}</Text>
                      <TouchableOpacity
                        onPress={doContactSync}
                        style={sty.findCtaBtn}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                      >
                        <Text style={sty.findCtaBtnText}>{t('chat.findContactsCtaBtn')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Contacts-on-Chatyy count chip — sits above "Pessoas que você
                      pode conhecer" so users immediately see how much of their
                      phone book overlaps with the network. */}
                  {phoneContacts.length > 0 && (
                    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
                      {/* [2026-10-10] Founder: "se eu clicar nisso deveria aparecer
                          meus contatos" — o chip agora rola até a seção
                          "Contatos no Chatyy". */}
                      <TouchableOpacity
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        onPress={() => {
                          const idx = sections.findIndex(sec => sec.key === 'phone_chatyy');
                          if (idx < 0 || !sectionListRef.current) return;
                          try { sectionListRef.current.scrollToLocation({ sectionIndex: idx, itemIndex: 0, animated: true, viewOffset: 0 }); } catch {}
                        }}
                        style={{
                          backgroundColor: colors.primary,
                          paddingHorizontal: 14,
                          paddingVertical: 8,
                          borderRadius: 999,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <Text style={{ color: colors.onPrimary || '#fff', fontSize: 12, fontWeight: '600' }}>
                          {(t('chat.contactsOnChatyyCount') ||
                            `${phoneContacts.length} dos seus ${(phoneContacts.length + otherContacts.length) || phoneContacts.length} contatos estão no Chatyy`)
                            .replace('{count}', String(phoneContacts.length))
                            .replace('{total}', String((phoneContacts.length + otherContacts.length) || phoneContacts.length))}
                        </Text>
                        <IconChevronDown size={14} color={colors.onPrimary || '#fff'} />
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Recently contacted (horizontal scroll) */}
                  {recentContacts.length > 0 && (
                    <View style={sty.recentSection}>
                      <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingBottom: 4 }]}>
                        <View style={sty.sectionAccentLine} />
                        <Text style={[sty.sectionTitle, { color: isDark ? '#F5F5F7' : '#111111' }]}>
                          {t('chat.recentContacts')}
                        </Text>
                      </View>
                      <FlatList
                        horizontal
                        data={recentContacts.slice(0, 8)}
                        keyExtractor={(item) => 'recent-' + item.email}
                        renderItem={renderRecentItem}
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={sty.recentList}
                      />
                    </View>
                  )}

                  {/* Quick actions */}
                  <View style={sty.quickActions}>
                    {/* Saved Messages — chat with self (Telegram-style) */}
                    <TouchableOpacity
                      style={[sty.quickActionRow, { borderBottomColor: colors.border }]}
                      onPress={async () => {
                        try {
                          const r = await api.chatSaved();
                          if (r?.success && r.data?.id) {
                            router.replace({ pathname: '/chat-conversation', params: { id: r.data.id, name: t('chat.savedMessages') || 'Saved Messages' } });
                          }
                        } catch {}
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={[sty.quickActionIcon, isDark && sty.iconChipDark]}>
                        <IconMessageSquare size={18} color="#fff" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[sty.quickActionTitle, { color: colors.text }]}>{t('chat.savedMessages') || 'Mensagens Salvas'}</Text>
                        <Text style={[sty.quickActionSub, { color: colors.textTertiary }]}>{t('chat.savedMessagesDesc') || 'Notas, links e arquivos que só você vê'}</Text>
                      </View>
                    </TouchableOpacity>

                    {/* Invite by email */}
                    <TouchableOpacity
                      style={[sty.quickActionRow, { borderBottomColor: colors.border }]}
                      onPress={() => setShowInviteInput(!showInviteInput)}
                      activeOpacity={0.7}
                    >
                      <View style={[sty.quickActionIcon, isDark && sty.iconChipDark]}>
                        <IconMail size={18} color="#fff" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[sty.quickActionTitle, { color: colors.text }]}>{t('chat.inviteFriend')}</Text>
                        <Text style={[sty.quickActionSub, { color: colors.textTertiary }]}>{t('chat.inviteFriendDesc')}</Text>
                      </View>
                    </TouchableOpacity>

                    {/* Inline invite input */}
                    {showInviteInput && (
                      <View style={[sty.inviteInputWrap, { backgroundColor: colors.surface }]}>
                        <TextInput
                          style={[sty.inviteInput, { color: colors.text, backgroundColor: isDark ? '#1e1e1e' : '#f5f5f7', borderColor: isDark ? '#333' : '#e0e0e0' }]}
                          placeholder={t('chat.emailPlaceholder')}
                          placeholderTextColor={colors.textTertiary}
                          value={inviteEmail}
                          onChangeText={setInviteEmail}
                          keyboardType="email-address"
                          autoCapitalize="none"
                        />
                        <TouchableOpacity
                          style={[sty.inviteSendBtn, { backgroundColor: inviteEmail.includes('@') ? '#111111' : colors.border }]}
                          disabled={!inviteEmail.includes('@') || !!invitingEmail}
                          onPress={() => {
                            handleInviteByEmail(inviteEmail.trim());
                            setInviteEmail('');
                          }}
                        >
                          {invitingEmail ? (
                            <ActivityIndicator size={14} color="#fff" />
                          ) : (
                            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                              {t('chat.sendInvite')}
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    )}

                    {/* Share invite link */}
                    <TouchableOpacity
                      style={[sty.quickActionRow, { borderBottomColor: colors.border }]}
                      onPress={() => handleInviteShare({})}
                      activeOpacity={0.7}
                    >
                      <View style={[sty.quickActionIcon, isDark && sty.iconChipDark]}>
                        <IconUserPlus size={18} color="#fff" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[sty.quickActionTitle, { color: colors.text }]}>{t('chat.shareLink')}</Text>
                        <Text style={[sty.quickActionSub, { color: colors.textTertiary }]}>{t('chat.shareLinkDesc')}</Text>
                      </View>
                    </TouchableOpacity>
                  </View>

                  {/* Invite count for non-Chatyy contacts */}
                  {otherContacts.length > 0 && (
                    <View style={[sty.inviteCountBanner, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.04)' }]}>
                      <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                        {t('chat.contactsNotOnChatyy', { count: otherContacts.length })}
                      </Text>
                    </View>
                  )}
                </View>
              }
              ListFooterComponent={
                <View style={{ paddingTop: 12 }}>
                  {/* Tópicos populares — Telegram-style trending hashtags
                      from public channels (last 7 days). Renders nothing
                      when the server returns no tags yet. */}
                  {mode === 'direct' && !pickMode && renderTrendingTagsBlock()}

                  {/* Comunidades — Telegram-style supergroups (announcement
                      channel + sub-groups + admin tools). Sits ABOVE
                      "Descobrir canais" so users discover the bigger feature
                      first. Hidden in member-pick flows. */}
                  {mode === 'direct' && !pickMode && (
                    <TouchableOpacity
                      onPress={() => router.push('/community/discover')}
                      activeOpacity={0.7}
                      style={{
                        marginHorizontal: Spacing.md,
                        marginTop: 8,
                        marginBottom: 4,
                        padding: 14,
                        borderRadius: 12,
                        backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <View style={{
                        width: 40, height: 40, borderRadius: 20,
                        backgroundColor: '#111111',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>C</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                          {t('chat.communitiesTitle') || 'Comunidades'}
                        </Text>
                        <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                          {t('chat.communitiesSubtitle') || 'Grupos grandes com canal de avisos e sub-grupos'}
                        </Text>
                      </View>
                      <Text style={{ color: colors.textSecondary, fontSize: 22, fontWeight: '300' }}>›</Text>
                    </TouchableOpacity>
                  )}

                  {/* Descobrir canais — Telegram-style public channel feed.
                      Only on the default "direct" mode (when picking who to
                      chat with). Hidden in group/channel-create flows where
                      the user is selecting members. */}
                  {mode === 'direct' && !pickMode && renderDiscoverBlock(publicChannels)}

                  {/* Listas de transmissão — Telegram parity. Section
                      shows the user's saved broadcast lists with a
                      "+ Nova lista" CTA at the top. Tapping a list opens
                      the contact picker pre-loaded with its members so
                      the user can edit and resend; tapping the CTA opens
                      a fresh BroadcastModal. Hidden in pickMode (the
                      add-member-to-group flow doesn't need this). */}
                  {!pickMode && mode === 'direct' && (
                    <View style={{ paddingHorizontal: Spacing.md, marginTop: 6, marginBottom: 4 }}>
                      <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingHorizontal: 0, paddingBottom: 6 }]}>
                        <View style={sty.sectionAccentLine} />
                        <Text style={[sty.sectionTitle, { color: isDark ? '#F5F5F7' : '#111111' }]}>
                          {t('chat.broadcastList') || 'Listas de transmissão'}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => setShowBroadcastModal(true)}
                        activeOpacity={0.7}
                        style={{
                          flexDirection: 'row', alignItems: 'center',
                          padding: 12, borderRadius: 12, gap: 12,
                          backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7',
                        }}
                      >
                        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' }}>
                          <IconBroadcastGlyph size={20} color="#fff" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                            {t('chat.newBroadcast') || 'Nova lista'}
                          </Text>
                          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                            {t('chat.broadcastListHint') || 'Envie uma mensagem para vários contatos de uma vez'}
                          </Text>
                        </View>
                        <IconPlus size={18} color={colors.textSecondary} />
                      </TouchableOpacity>
                      {broadcastLists.length > 0 && broadcastLists.map((bl) => {
                        const count = (bl.recipients || []).length;
                        return (
                          <TouchableOpacity
                            key={`bl-${bl.id}`}
                            activeOpacity={0.7}
                            onPress={() => {
                              // No dedicated /chat-broadcast-send screen yet; use
                              // a native prompt as the lightweight composer. The
                              // backend's chat_broadcast_send fans the text out
                              // to each recipient's direct thread, which already
                              // surfaces in the chat list. Cancel = no-op.
                              const promptTitle = bl.name || (t('chat.broadcastList') || 'Lista de transmissão');
                              const sendIt = (text) => {
                                const v = (text || '').trim();
                                if (!v) return;
                                api.chatBroadcastSend(bl.id, v).then(r => {
                                  if (r?.success) {
                                    safeAlert(
                                      t('chat.broadcastSent') || 'Enviado',
                                      `${r.data?.sent ?? count} / ${r.data?.total ?? count}`
                                    );
                                  }
                                }).catch(() => {});
                              };
                              if (Platform.OS === 'ios' && Alert.prompt) {
                                Alert.prompt(promptTitle, t('chat.broadcastSend') || 'Mensagem para a lista', sendIt);
                              } else if (Platform.OS === 'web') {
                                const txt = window.prompt(`${promptTitle}\n${t('chat.broadcastSend') || 'Mensagem'}`);
                                if (txt != null) sendIt(txt);
                              } else {
                                // Android: no Alert.prompt — open a real input modal that
                                // composes the message and sends via chatBroadcastSend.
                                setBroadcastComposeText('');
                                setBroadcastComposeList(bl);
                              }
                            }}
                            onLongPress={() => {
                              // Long-press → quick delete (Telegram parity).
                              if (!api.chatBroadcastDelete) return;
                              const confirmDelete = () => {
                                api.chatBroadcastDelete(bl.id).then(() => loadBroadcastLists()).catch(() => {});
                              };
                              if (Platform.OS === 'web') {
                                if (window.confirm(`${t('common.delete') || 'Excluir'}?`)) confirmDelete();
                              } else {
                                Alert.alert(
                                  bl.name || (t('chat.broadcastList') || 'Lista de transmissão'),
                                  t('chat.deleteBroadcastConfirm') || 'Excluir esta lista?',
                                  [
                                    { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                                    { text: t('common.delete') || 'Excluir', style: 'destructive', onPress: confirmDelete },
                                  ],
                                );
                              }
                            }}
                            delayLongPress={400}
                            style={{
                              flexDirection: 'row', alignItems: 'center',
                              paddingVertical: 10, gap: 12,
                            }}
                          >
                            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#111111' + '22', alignItems: 'center', justifyContent: 'center' }}>
                              <IconBroadcastGlyph size={18} color={colors.primary} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>
                                {bl.name || (t('chat.broadcastList') || 'Lista de transmissão')}
                              </Text>
                              <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 2 }}>
                                {count} {t('chat.broadcastMembers') || 'membros'}
                              </Text>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}

                </View>
              }
              ListEmptyComponent={
                !isLoading ? (
                  <View style={sty.emptyResults}>
                    <IconUsers size={48} color={colors.textTertiary} />
                    <Text style={[sty.emptyTitle, { color: colors.text, marginTop: 16 }]}>
                      {t('chat.noContactsYet')}
                    </Text>
                    <Text style={[sty.emptyText, { color: colors.textTertiary, marginTop: 4 }]}>
                      {t('chat.inviteFriendsHint')}
                    </Text>
                  </View>
                ) : null
              }
            />
          </View>

          {/* Alphabet sidebar (only for contact list, not search) */}
          {alphabetLetters.length > 5 && !searchText && (
            <AlphabetSidebar letters={alphabetLetters} onPress={handleAlphabetPress} colors={colors} />
          )}
        </View>
      )}

      {/* Add email hint -- only for group mode */}
      {searchText && searchText.includes('@') && searchResults.length === 0 && !searching && mode !== 'direct' && (
        <TouchableOpacity
          style={[sty.addEmailRow, { borderBottomColor: colors.border, position: 'absolute', bottom: 100, left: 0, right: 0, backgroundColor: colors.background }]}
          onPress={handleAddEmail}
        >
          <IconPlus size={18} color={colors.primary} />
          <Text style={[sty.addEmailText, { color: colors.primary }]}>
            {t('chat.addEmail', { email: searchText })}
          </Text>
        </TouchableOpacity>
      )}

      {/* Create Group Button */}
      {mode === 'group' && selectedMembers.length > 0 && (
        <View style={[sty.createBtnWrap, { paddingBottom: insets.bottom + Spacing.md }]}>
          <TouchableOpacity
            style={[sty.createBtn, { backgroundColor: colors.primary }, Shadow.md]}
            onPress={handleCreateGroup}
            disabled={creating}
          >
            {creating ? <ActivityIndicator size="small" color={colors.onPrimary || '#fff'} /> : (
              <>
                <IconUsers size={18} color={colors.onPrimary || '#fff'} />
                <Text style={sty.createBtnText}>{t('chat.createGroup', { count: selectedMembers.length })}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Create Channel Button */}
      {mode === 'channel' && groupName.trim() && (
        <View style={[sty.createBtnWrap, { paddingBottom: insets.bottom + Spacing.md }]}>
          <TouchableOpacity
            style={[sty.createBtn, { backgroundColor: colors.primary }, Shadow.md]}
            onPress={handleCreateChannel}
            disabled={creating}
          >
            {creating ? <ActivityIndicator size="small" color={colors.onPrimary || '#fff'} /> : (
              <>
                <Text style={{ fontSize: 16, marginRight: 6 }}>{'#'}</Text>
                <Text style={sty.createBtnText}>{t('chat.createChannel')}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* QR Code Modal */}
      <Modal
        visible={showQrModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowQrModal(false)}
      >
        <View style={sty.modalOverlay}>
          <View style={[sty.qrModal, { backgroundColor: colors.surface }]}>
            <View style={sty.qrModalHeader}>
              <Text style={[sty.qrModalTitle, { color: colors.text }]}>{t('chat.qrCode')}</Text>
              <TouchableOpacity onPress={() => setShowQrModal(false)} style={{ padding: 8 }}>
                <IconX size={22} color={colors.text} />
              </TouchableOpacity>
            </View>

            {qrMode === 'show' ? (
              <View style={sty.qrContent}>
                {/* Show user's QR code (email-based) */}
                <View style={[sty.qrCodeBox, { backgroundColor: '#fff', borderColor: colors.border }]}>
                  <AvatarCircle email={user?.email || ''} name={user?.name || user?.email || ''} size={72} colors={colors} />
                  <Text style={{ fontSize: 16, fontWeight: '600', color: '#000', marginTop: 12 }}>
                    {user?.name || user?.email?.split('@')[0]}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                    {user?.email}
                  </Text>
                  <View style={{ marginTop: 16, padding: 12, backgroundColor: '#fff', borderRadius: 12 }}>
                    {QRCodeSvg ? (
                      <QRCodeSvg value={qrData} size={180} color="#000" backgroundColor="#fff" />
                    ) : (
                      <Text style={{ width: 180, fontSize: 12, color: '#333', textAlign: 'center' }} selectable>{profileLink}</Text>
                    )}
                  </View>
                  <Text style={{ fontSize: 12, color: '#999', marginTop: 12, textAlign: 'center' }}>
                    {t('chat.qrShareDesc')}
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                  <TouchableOpacity
                    style={[sty.qrActionBtn, { backgroundColor: '#111111' }]}
                    onPress={handleQrScan}
                  >
                    <IconSearch size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{t('chat.qrScan')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[sty.qrActionBtn, { backgroundColor: '#111111' }]}
                    onPress={handleShareQrImage}
                  >
                    <IconMail size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{t('chat.shareLink')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={sty.qrContent}>
                {Platform.OS !== 'web' ? (
                  <>
                    <View style={sty.qrScannerBox}>
                      <CameraView
                        style={StyleSheet.absoluteFill}
                        facing="back"
                        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                        onBarcodeScanned={qrScanned ? undefined : handleBarCodeScanned}
                      />
                      <View style={sty.qrScanOverlay}>
                        <View style={sty.qrScanFrame} />
                      </View>
                    </View>
                    <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 16, fontSize: 13 }}>
                      {t('chat.qrScanDesc')}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={{ color: colors.textSecondary, textAlign: 'center', marginBottom: 16 }}>
                      {t('chat.qrScanDesc')}
                    </Text>
                    <TextInput
                      style={[sty.inviteInput, { color: colors.text, backgroundColor: isDark ? '#1e1e1e' : '#f5f5f7', borderColor: isDark ? '#333' : '#e0e0e0', width: '100%' }]}
                      placeholder={t('chat.qrEnterEmail')}
                      placeholderTextColor={colors.textTertiary}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      onSubmitEditing={(e) => {
                        const email = e.nativeEvent.text.trim();
                        if (email && email.includes('@')) {
                          setShowQrModal(false);
                          handleCreateDirect(email, email);
                        }
                      }}
                    />
                  </>
                )}
                <TouchableOpacity
                  style={[sty.qrActionBtn, { backgroundColor: '#111111', marginTop: 16, alignSelf: 'stretch' }]}
                  onPress={() => setQrMode('show')}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{t('chat.qrShowMine')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Broadcast list creator — multi-select contacts + name input.
          Reuses the existing components/BroadcastModal which talks to
          chat_broadcast_create directly and reports back via onCreated. */}
      <BroadcastModal
        visible={showBroadcastModal}
        onClose={() => setShowBroadcastModal(false)}
        onCreated={() => { setShowBroadcastModal(false); loadBroadcastLists(); }}
        colors={colors}
        t={t}
      />

      {/* Android broadcast composer — Alert.prompt is iOS-only, so Android
          uses this inline modal to type and send to a broadcast list. */}
      <Modal
        visible={!!broadcastComposeList}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!broadcastSending) setBroadcastComposeList(null); }}
      >
        <View style={sty.modalOverlay}>
          <View style={[sty.qrModal, { backgroundColor: colors.surface }]}>
            <View style={sty.qrModalHeader}>
              <Text style={[sty.qrModalTitle, { color: colors.text }]} numberOfLines={1}>
                {broadcastComposeList?.name || (t('chat.broadcastList') || 'Lista de transmissão')}
              </Text>
              <TouchableOpacity
                onPress={() => { if (!broadcastSending) { setBroadcastComposeList(null); broadcastCmiRef.current = null; } }}
                style={{ padding: 8 }}
              >
                <IconX size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
              {(broadcastComposeList?.recipients || []).length} {t('chat.broadcastMembers') || 'membros'}
            </Text>
            <TextInput
              style={[sty.inviteInput, { color: colors.text, backgroundColor: isDark ? '#1e1e1e' : '#f5f5f7', borderColor: isDark ? '#333' : '#e0e0e0', width: '100%', minHeight: 80, textAlignVertical: 'top' }]}
              placeholder={t('chat.broadcastSend') || 'Mensagem para a lista'}
              placeholderTextColor={colors.textTertiary}
              value={broadcastComposeText}
              onChangeText={setBroadcastComposeText}
              multiline
              autoFocus
            />
            <TouchableOpacity
              style={[sty.qrActionBtn, { backgroundColor: '#111111', marginTop: 16, alignSelf: 'stretch', opacity: (broadcastSending || !broadcastComposeText.trim()) ? 0.5 : 1 }]}
              disabled={broadcastSending || !broadcastComposeText.trim()}
              onPress={() => {
                const bl = broadcastComposeList;
                const v = (broadcastComposeText || '').trim();
                if (!bl || !v) return;
                const count = (bl.recipients || []).length;
                setBroadcastSending(true);
                if (!broadcastCmiRef.current) {
                  broadcastCmiRef.current = 'bcast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                }
                api.chatBroadcastSend(bl.id, v, 'text', '', '', '', broadcastCmiRef.current).then(r => {
                  setBroadcastSending(false);
                  setBroadcastComposeList(null);
                  setBroadcastComposeText('');
                  // Session over either way (the modal closes and the text is
                  // cleared even on failure) — next compose is a new blast.
                  broadcastCmiRef.current = null;
                  if (r?.success) {
                    safeAlert(
                      t('chat.broadcastSent') || 'Enviado',
                      `${r.data?.sent ?? count} / ${r.data?.total ?? count}`
                    );
                  }
                }).catch(() => {
                  setBroadcastSending(false);
                });
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>
                {broadcastSending ? (t('common.sending') || 'Enviando...') : (t('common.send') || 'Enviar')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const sty = StyleSheet.create({
  // [2026-10-09 find-contacts] shortcuts row + agenda CTA
  shortcutRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 8, paddingTop: 10, paddingBottom: 6 },
  shortcutTile: { alignItems: 'center', width: 80, paddingVertical: 4 },
  shortcutIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' },
  shortcutLabel: { fontSize: 12, fontWeight: '500', marginTop: 6, textAlign: 'center' },
  // [2026-10-10 polish-list] dark: #111 chip on the #000 page was invisible.
  iconChipDark: { backgroundColor: '#2C2C2E' },
  findCta: { marginHorizontal: 16, marginTop: 8, marginBottom: 6, padding: 14, borderRadius: 12 },
  findCtaTitle: { fontSize: 15, fontWeight: '700' },
  findCtaDesc: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  findCtaBtn: { alignSelf: 'flex-start', marginTop: 10, backgroundColor: '#111111', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999 },
  findCtaBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: 0,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, flex: 1, textAlign: 'center' },
  toggleRow: {
    flexDirection: 'row', marginHorizontal: Spacing.md, marginTop: 12,
    borderRadius: 14, padding: 4, gap: 4,
  },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, borderRadius: 11, gap: 6,
  },
  toggleBtnActive: {
    ...Platform.select({
      web: { boxShadow: '0 2px 6px rgba(0,0,0,0.12)' },
      default: {},
    }),
    elevation: 2,
    shadowColor: '#111111',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
  },
  toggleText: { fontSize: 13, fontWeight: '600' },
  groupNameWrap: {
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupNameInput: {
    fontSize: 15, paddingHorizontal: 16, height: 48,
    borderRadius: 14, borderWidth: 1,
    ...Platform.select({
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
      default: {},
    }),
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
  },
  selectedRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    // Fixed content height — previously the row grew/collapsed as chips
    // were added/removed, which looked like the layout was "breaking".
    height: 92,
    justifyContent: 'center',
  },
  selectedList: { paddingHorizontal: Spacing.md, gap: 14, alignItems: 'center' },
  selectedChip: {
    alignItems: 'center', justifyContent: 'flex-start',
    width: 64,
    // Avoid chip being squeezed on FlatList layout — each item keeps its
    // own width so avatars never overlap.
    flexShrink: 0,
  },
  selectedChipClose: {
    position: 'absolute', top: -2, right: -2,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  selectedChipText: { fontSize: 11, fontWeight: '500', marginTop: 4, textAlign: 'center' },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.md, marginVertical: 10,
    paddingHorizontal: 14, height: 44,
    borderRadius: 16, gap: 10,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  searchClearBtn: { padding: 4 },
  searchClearCircle: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#111111',
    alignItems: 'center', justifyContent: 'center',
  },
  addEmailRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addEmailText: { fontSize: FontSize.md, fontWeight: '500' },

  // Recent contacts horizontal scroll
  recentSection: { paddingTop: 8, paddingBottom: 4 },
  recentList: { paddingHorizontal: Spacing.md, gap: 2 },
  recentItem: { alignItems: 'center', width: 72, paddingVertical: 8 },
  recentName: { fontSize: 11, marginTop: 6, textAlign: 'center', fontWeight: '500' },
  onlineDot: {
    position: 'absolute', bottom: 2, right: 2,
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#111111', borderWidth: 2,
  },
  onlineDotSmall: {
    position: 'absolute', bottom: 0, right: 0,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#111111', borderWidth: 2,
  },

  // Quick actions
  quickActions: { paddingTop: 4 },
  quickActionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 14,
  },
  quickActionIcon: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#111111',
  },
  quickActionTitle: { fontSize: 16, fontWeight: '500' },
  quickActionSub: { fontSize: 13, marginTop: 2 },

  inviteInputWrap: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.md, marginTop: 6, marginBottom: 6,
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
    borderRadius: 14,
  },
  inviteInput: {
    flex: 1, fontSize: 15, paddingHorizontal: 14, height: 44,
    borderRadius: 14, borderWidth: 1,
  },
  inviteSendBtn: {
    paddingHorizontal: 18, height: 44, justifyContent: 'center', alignItems: 'center',
    borderRadius: 14,
  },

  inviteCountBanner: {
    marginHorizontal: Spacing.md, marginTop: 8, marginBottom: 4,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 12,
  },

  loaderWrap: { paddingVertical: 40, alignItems: 'center' },
  contactList: { paddingBottom: 100 },
  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 14,
  },
  contactAvatarRing: {
    // Subtle brand ring around 40px avatar — signals "Chatyy user" without
    // pill noise. 2px purple ring with 4px halo for crispness.
    padding: 2, borderRadius: 24,
    borderWidth: 1, borderColor: 'rgba(17, 17, 17,0.10)',
    position: 'relative',
  },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 16, fontWeight: '500' },
  contactSub: { fontSize: 12, marginTop: 2, opacity: 0.7 },
  contactAbout: { fontSize: 12, marginTop: 3, fontStyle: 'italic' },
  // Hoisted static inline objects from the old inline row renderer — keeps the
  // memoized ContactRow from allocating fresh style objects on every render.
  flex1: { flex: 1 },
  shrink0: { flexShrink: 0 },
  rowCenterGap6: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowCenterGap6Min: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  usernameInline: { fontSize: 12, color: '#111111', fontWeight: '600', flexShrink: 0 },
  novoBadge: {
    backgroundColor: '#111111',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 2,
    flexShrink: 0,
  },
  novoBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  chatyyBadge: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10,
  },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  inviteBtn: {
    paddingHorizontal: 14, height: 32, justifyContent: 'center', alignItems: 'center',
    borderRadius: 14,
    backgroundColor: '#111111',
    ...Platform.select({
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.14)' },
      default: {},
    }),
    elevation: 2,
    shadowColor: '#111111',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.14,
    shadowRadius: 4,
  },
  inviteBtnText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },
  inviteBtnWithIcon: {
    // Match brand pill spacing when icon + label render side-by-side. The
    // icon adds visual weight so we expand padding slightly and use gap.
    flexDirection: 'row', gap: 6, paddingHorizontal: 16,
  },
  inviteIconBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
  },
  emptyResults: { alignItems: 'center', paddingTop: 60, paddingHorizontal: Spacing.xl },
  emptyIconCircle: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 17, fontWeight: '600', textAlign: 'center', marginBottom: 6 },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  emptyActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, height: 40,
    borderRadius: 20, justifyContent: 'center',
    ...Platform.select({
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.15)' },
      default: {},
    }),
    elevation: 3,
  },
  emptyActionText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // Public channel discovery
  discoverChip: {
    paddingHorizontal: 14, height: 32,
    borderRadius: 16, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  channelCard: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 12,
  },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 8, gap: 8,
  },
  sectionAccentLine: {
    width: 0, height: 0,
  },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, color: '#111111' },
  // WhatsApp-style single-letter mini header for A-Z grouping. Slimmer
  // than the full sectionHeader so the on-Chatyy list doesn't feel
  // chopped up — just a tiny brand-colored letter pinned at the top
  // of each letter bucket.
  letterHeader: {
    paddingHorizontal: Spacing.md, paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(17, 17, 17,0.10)',
  },
  letterHeaderText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  createBtnWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, height: 50, borderRadius: 25,
    backgroundColor: '#111111',
    ...Platform.select({
      web: { boxShadow: '0 2px 10px rgba(0,0,0,0.16)' },
      default: {},
    }),
    elevation: 3,
    shadowColor: '#111111',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
  },
  createBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },

  // Alphabet sidebar
  // [2026-10-10] Was position:absolute over the whole list → the letters sat
  // on top of the "Recentes" carousel / shortcut rows. Now a real column in
  // the flexDirection:'row' container, so the list (and its header rows) end
  // before the index and nothing overlaps.
  alphabetSidebar: {
    width: 22, marginRight: 2,
    justifyContent: 'center', alignItems: 'center',
  },
  alphabetInner: {
    paddingVertical: 4, alignItems: 'center',
  },
  alphabetLetter: { paddingVertical: 1, paddingHorizontal: 4 },
  alphabetLetterText: { fontSize: 10, fontWeight: '700' },

  // QR Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center',
    padding: 24,
  },
  qrModal: {
    width: '100%', maxWidth: 400,
    borderRadius: 24, overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 8px 32px rgba(0,0,0,0.2)' },
      default: {},
    }),
    elevation: 10,
  },
  qrModalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e0e0e0',
  },
  qrModalTitle: { fontSize: 20, fontWeight: '700' },
  qrContent: { padding: 24, alignItems: 'center' },
  qrCodeBox: {
    alignItems: 'center', padding: 24, borderRadius: 20,
    borderWidth: 1, width: '100%',
  },
  qrScannerBox: {
    width: '100%', height: 280, borderRadius: 16, overflow: 'hidden',
    backgroundColor: '#000', position: 'relative',
  },
  qrScanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center', alignItems: 'center',
  },
  qrScanFrame: {
    width: 200, height: 200, borderWidth: 2, borderColor: '#111111',
    borderRadius: 16, backgroundColor: 'transparent',
  },
  qrActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, height: 44, borderRadius: 22,
    justifyContent: 'center', flex: 1,
  },
});
