import ErrorBoundary from "../components/ErrorBoundary";
import PressableRow from '../components/PressableRow'; // [2026-10-07 app-feel-ui] native cell feedback
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import React from 'react';
import {
  View, FlatList, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView,
  ActivityIndicator, Platform, Modal, Alert, SectionList, Animated, Easing,
  KeyboardAvoidingView, RefreshControl,
} from 'react-native';
// FlashList reverted to FlatList
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton, NativeHeaderSafeArea } from '../components/nativeHeader'; // [2026-10-07 app-feel-nav]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import * as api from '../services/api';
import { getCachedEntrySync, setCache } from '../services/cache';
// [2026-10-14 offline-first] lista salva lida com idade máx. 7 dias (o prewarm do
// _layout grava com expiry de 10 min → depois disso getCachedSync dava null e a
// tela voltava ao spinner; getCached ainda APAGAVA a cópia expirada).
const _contactsDisk = () => { try { const e = getCachedEntrySync('contacts'); return e && e.data && Array.isArray(e.data.data) ? e.data.data : null; } catch { return null; } };
import { ListSkeleton } from '../components/SkeletonLoader';
import {
  IconArrowLeft, IconUser, IconMail, IconPhone, IconPlus,
  IconX, IconCheck, IconSearch, IconTrash, IconUsers, IconTag,
  IconDownload, IconUpload, IconRefresh, IconSmartphone,
  IconChevronDown, IconChevronUp, IconStar, IconEdit, IconFileText,
  IconBuilding, IconBriefcase, IconCake, IconMapPin, IconGlobe,
  IconMessageSquare, IconVideo, IconSend,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import SwipeAction from '../components/SwipeAction';
import ScreenEmptyState from '../components/ScreenEmptyState';
import FadeSlideIn from '../components/FadeSlideIn';
import { Sheet, ActionList } from '../components/ui'; // [2026-10-16 polish-r2]
import PressableScale from '../components/PressableScale';
import InviteContactSheet from '../components/InviteContactSheet'; // [2026-10-13 contacts-invite]
import { shareInvite as shareInviteLink, prefetchInviteRef } from '../services/inviteContact';
// [2026-10-15 native-contacts] "Meus contatos" em NATIVO (seções fixas + índice
// A–Z com haptic). Binário sem a view / web / kill switch → SectionList abaixo.
import NativeContactList, { nativeContactsEnabled } from '../components/contacts/NativeContactList';
import { buildFlatRows, contactTile } from '../components/contacts/contactListAdapter';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragBackdrop } from '../components/ui/useDragToDismiss';

// Try to import expo-contacts (available on native, unavailable on web)
let Contacts = null;
try {
  Contacts = require('expo-contacts');
} catch {}

// [perf] getAvatarColor is a pure function of `name` but was string-hashing
// the name on EVERY row render (device/family/contact rows call it inline).
// Memoize the result per name in a module-level Map so scrolling never
// recomputes the hash for a name already seen. Output is byte-for-byte
// identical to the original — same hash, same palette index — so behavior is
// unchanged; this only skips redundant work.
const _avatarColorCache = new Map();
function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  const cached = _avatarColorCache.get(name);
  if (cached !== undefined) return cached;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const color = Colors.avatarColors[Math.abs(hash) % Colors.avatarColors.length];
  _avatarColorCache.set(name, color);
  return color;
}

// ---------- vCard helpers ----------
function escapeVCardValue(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function contactToVCard(c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const fn = c.name || c.email || '';
  lines.push(`FN:${escapeVCardValue(fn)}`);
  const parts = (c.name || '').trim().split(/\s+/);
  if (parts.length > 1) {
    lines.push(`N:${escapeVCardValue(parts[parts.length - 1])};${escapeVCardValue(parts.slice(0, -1).join(' '))};;;`);
  } else if (parts[0]) {
    lines.push(`N:;${escapeVCardValue(parts[0])};;;`);
  } else {
    lines.push('N:;;;;');
  }
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(c.email)}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${escapeVCardValue(c.phone)}`);
  if (c.group) lines.push(`CATEGORIES:${escapeVCardValue(c.group)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function parseVCards(text) {
  const results = [];
  const blocks = text.split(/BEGIN:VCARD/i).filter(b => b.trim());
  for (const block of blocks) {
    const endIdx = block.toUpperCase().indexOf('END:VCARD');
    const content = endIdx >= 0 ? block.substring(0, endIdx) : block;
    const lines = content.split(/\r?\n/);
    let fn = '', email = '', phone = '', categories = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const field = line.substring(0, colonIdx).toUpperCase();
      const value = line.substring(colonIdx + 1).replace(/\\n/g, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
      if (field === 'FN' || field.startsWith('FN;')) fn = value;
      else if (field.startsWith('EMAIL')) email = value;
      else if (field.startsWith('TEL')) phone = value;
      else if (field === 'CATEGORIES' || field.startsWith('CATEGORIES;')) categories = value;
    }
    if (email || fn) results.push({ name: fn, email, phone, group: categories });
  }
  return results;
}

// Format "last contacted" relative time
function formatLastContacted(dateStr, t) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return t('calendar.today') || 'Today';
  if (diffDays === 1) return t('calendar.tomorrow') === 'tomorrow' ? 'yesterday' : 'ontem';
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}m`;
  return `${Math.floor(diffDays / 365)}y`;
}

// ---------- In-memory cache for device contacts ----------
let _deviceContactsCache = null;
let _deviceContactsCacheTime = 0;
const DEVICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const BATCH_SIZE = 50;

// ---------- Memoized contact row components ----------

// [2026-10-13 contacts-invite] Pílula "Convidar" (WhatsApp) — linhas de quem
// NÃO tem Chatyy. Preto/branco do app (texto = cor do tema, contorno fino).
function InvitePill({ onPress, colors, t }) {
  const label = t('chat.invite') || 'Convidar';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      style={[s.invitePill, { borderColor: colors.text }]}
    >
      <Text style={[s.invitePillText, { color: colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const DeviceContactRow = React.memo(({ dc, colors, saved, onAdd, t, isRegistered, chatyyEmail, onOpenProfile, onQuickActions, checked, onInvite }) => {
  const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim() || t('contacts.unknown');
  // matched by phone → the agenda entry has no e-mail; use the account's.
  const email = dc.emails?.[0]?.email || chatyyEmail || '';
  const phone = dc.phoneNumbers?.[0]?.number || '';

  // Registered Chatyy users get the same tap = profile / long-press = quick
  // actions affordance the saved-contacts list has.
  // [2026-10-13 contacts-invite] Sem conta Chatyy NÃO há perfil p/ abrir: o
  // toque abre a folha "Convidar para o Chatyy" (+ ligar/SMS/copiar número).
  const Wrapper = (isRegistered && (onOpenProfile || onQuickActions)) || (!isRegistered && onInvite) ? PressableRow : View; // [2026-10-07 app-feel-ui] native cell feedback
  const wrapperProps = isRegistered && (onOpenProfile || onQuickActions)
    ? {
        onPress: () => onOpenProfile?.({ email, name, phone }),
        onLongPress: () => onQuickActions?.({ email, name, phone }),
        delayLongPress: 350,
        activeOpacity: 0.6,
      }
    : (!isRegistered && onInvite ? {
        onPress: () => onInvite(dc),
        onLongPress: () => onInvite(dc),
        delayLongPress: 350,
        activeOpacity: 0.6,
        accessibilityRole: 'button',
        accessibilityHint: t('invite.toChatyy') || 'Convidar para o Chatyy',
      } : {});

  return (
    <Wrapper style={[s.contactRow, { borderBottomColor: colors.borderLight }]} {...wrapperProps}>
      {/* [2026-10-13 visual] avatar P&B do app (era círculo colorido por hash) */}
      <AvatarCircle name={name} email={isRegistered ? email : undefined} size={40} style={{ marginRight: Spacing.md }} />
      <View style={s.contactInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={[s.contactName, { color: colors.text, flexShrink: 1 }]}>{name}</Text>
          {isRegistered && (
            // [2026-10-17 wa-polish] selo P&B (era verde successBg — fora da paleta).
            <View style={[s.groupChip, { backgroundColor: colors.primaryLight, marginTop: 0 }]}>
              <Text style={[s.groupChipText, { color: colors.primary }]}>Chatyy</Text>
            </View>
          )}
        </View>
        {!!email && <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{email}</Text>}
        {!!phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{phone}</Text>}
      </View>
      {!isRegistered && checked && onInvite ? (
        <InvitePill onPress={() => onInvite(dc)} colors={colors} t={t} />
      ) : saved ? (
        <View style={s.savedBadge}>
          <IconCheck size={14} color={colors.primary} />
        </View>
      ) : (
        <TouchableOpacity onPress={() => onAdd(dc)} style={[s.addContactBtn, { borderColor: colors.primary }]}>
          <IconPlus size={14} color={colors.primary} />
        </TouchableOpacity>
      )}
    </Wrapper>
  );
});

const FamilyUserRow = React.memo(({ user, colors, saved, onAdd, t, onOpenProfile, onQuickActions }) => {
  // [bug 2026-05-21 #fam-crash] Backend search merge could push entries
  // with `email: undefined` (when search results lack the field), then
  // `user.email.split('@')[0]` below crashed the whole tab. Normalize.
  const safeEmail = (user?.email || '').toString();
  const safeDisplay = (user?.display_name || '').toString();
  const fallbackInitial = (safeDisplay || safeEmail || '?')[0] || '?';
  const displayName = safeDisplay || (safeEmail.includes('@') ? safeEmail.split('@')[0] : safeEmail) || '—';
  return (
    <PressableRow
      style={[s.contactRow, { borderBottomColor: colors.borderLight }]}
      onPress={() => onOpenProfile?.(user)}
      onLongPress={() => onQuickActions?.(user)}
      delayLongPress={350}
      activeOpacity={0.6}
    >
      {/* [2026-10-12 chatlist-wa] real profile photo (was initials only) and no
          "Família" badge — every row in this tab is a Chatyy user. */}
      <AvatarCircle name={safeDisplay || safeEmail || fallbackInitial} email={safeEmail} size={40} style={{ marginRight: Spacing.md }} />
      <View style={s.contactInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[s.contactName, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
        </View>
        {!!safeEmail && <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{safeEmail}</Text>}
        {!!user?.phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{user.phone}</Text>}
      </View>
      {saved ? (
        <View style={s.savedBadge}>
          <IconCheck size={14} color={colors.primary} />
        </View>
      ) : (
        <TouchableOpacity onPress={() => onAdd(user)} style={[s.addContactBtn, { borderColor: colors.primary }]}>
          <IconPlus size={14} color={colors.primary} />
        </TouchableOpacity>
      )}
    </PressableRow>
  );
});

const MyContactRow = React.memo(({ c, colors, onEdit, onDelete, onToggleFav, onOpenProfile, onQuickActions, notOnChatyy, onInvite }) => {
  const { t } = useLanguage();
  return (
    <SwipeAction
      onSwipeLeft={() => onDelete(c.email)}
      rightContent={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <IconTrash size={18} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>{t('common.delete')}</Text>
        </View>
      }
      style={{ backgroundColor: colors.error }}
    >
    <PressableRow
      style={[s.contactRow, { borderBottomColor: colors.borderLight, backgroundColor: colors.background }]}
      onPress={() => onOpenProfile ? onOpenProfile(c) : onEdit(c)}
      onLongPress={() => onQuickActions?.(c)}
      delayLongPress={350}
      activeOpacity={0.6}
    >
      <AvatarCircle name={c.name || c.email} email={c.email} size={40} style={{ marginRight: Spacing.md }} />
      <View style={s.contactInfo}>
        <Text style={[s.contactName, { color: colors.text }]}>{c.name || (c.email || '').toLowerCase()}</Text>
        <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{(c.email || '').toLowerCase()}</Text>
        {!!c.phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{c.phone}</Text>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {!!c.group && (
            <View style={[s.groupChip, { backgroundColor: colors.primaryLight }]}>
              <Text style={[s.groupChipText, { color: colors.primary }]}>{c.group}</Text>
            </View>
          )}
          {!!c.last_contacted && (
            <Text style={[s.lastContactedText, { color: colors.textTertiary }]}>
              {c._lastContactedFormatted}
            </Text>
          )}
        </View>
      </View>
      {notOnChatyy && onInvite ? <InvitePill onPress={() => onInvite(c)} colors={colors} t={t} /> : null}
      <TouchableOpacity onPress={() => onToggleFav(c)} style={s.starBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <IconStar size={18} color={c.favorite ? colors.warning : colors.textTertiary} style={c.favorite ? { opacity: 1 } : { opacity: 0.4 }} />
      </TouchableOpacity>
      {/* [2026-10-17 wa-polish] lixeira fixa removida — deslizar / segurar → Excluir. */}
    </PressableRow>
    </SwipeAction>
  );
});

// ---- Polished Empty State for Contacts ----
function ContactsEmptyState({ colors, isDark, t, searching, onAdd, onClearSearch, onSync, onDiscover, onFindFriends }) {
  if (searching) {
    return (
      <ScreenEmptyState
        kind="search"
        title={t('contacts.emptyState.searchTitle') || t('contacts.noContactsFound') || t('contacts.noContacts')}
        subtitle={t('contacts.emptyState.searchSubtitle') || t('contacts.tryDifferentSearch')}
        secondary={onClearSearch ? { label: t('contacts.emptyState.clearSearch') || 'Limpar busca', onPress: onClearSearch } : undefined}
      />
    );
  }

  return (
    <ScreenEmptyState
      kind="contacts"
      title={t('contacts.emptyState.title') || t('contacts.noContacts')}
      subtitle={t('contacts.emptyState.subtitle') || t('contacts.emptyDesc')}
      cta={{ label: t('contacts.emptyState.cta') || t('contacts.addContact'), icon: 'plus', onPress: onAdd }}
      tips={[
        { icon: 'upload', label: t('contacts.emptyState.tipSync') || 'Sincronize os contatos do seu telefone', onPress: onSync },
        { icon: 'sparkles', label: t('contacts.emptyState.tipDiscover') || 'Descubra contatos dos seus e-mails enviados', onPress: onDiscover },
        { icon: 'users', label: t('contacts.emptyState.tipFriends') || 'Encontre amigos que já estão no Chatyy', onPress: onFindFriends },
      ]}
    />
  );
}

function ContactsScreenInner() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user: _authUser } = useAuth();
  const myEmailRef = useRef('');
  myEmailRef.current = String(_authUser?.email || '');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // [2026-10-17 drag-dismiss] cartões "Novo/editar contato" e "Enviar contato para" descem arrastando.
  const _addDrag = useDragToDismiss({ onDismiss: () => setShowAdd(false) });
  const _shareDrag = useDragToDismiss({ onDismiss: () => setShareContactCard(null) });

  const [activeTab, setActiveTab] = useState('my');
  // [cache-first] Seed synchronously from MMKV so the address book paints on
  // frame 1 (no spinner). loadContacts() below still revalidates. Guard on the
  // active account so account A never flashes under account B during the window
  // before AuthContext sets the cache user (getCachedSync falls back to
  // _noacct otherwise). Mirrors app/notifications.js:399-404.
  const [contacts, setContacts] = useState(() => {
    try {
      if (api.getActiveAccountEmail && api.getActiveAccountEmail()) {
        const cached = _contactsDisk();
        if (cached) return cached;
      }
    } catch {}
    return [];
  });
  const [loading, setLoading] = useState(() => {
    try {
      if (api.getActiveAccountEmail && api.getActiveAccountEmail()) {
        if (_contactsDisk()) return false;
      }
    } catch {}
    return true;
  });
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', group: '', notes: '', favorite: false, company: '', job_title: '', birthday: '', address: '', website: '' });
  const [sortMode, setSortMode] = useState('alpha'); // alpha | favorites | recent
  const [saving, setSaving] = useState(false);
  const [activeGroup, setActiveGroup] = useState('all');
  const [loadError, setLoadError] = useState(false);
  const [emailError, setEmailError] = useState('');

  // Device contacts - batched loading
  const [deviceContacts, setDeviceContacts] = useState([]);
  const [deviceContactsAll, setDeviceContactsAll] = useState([]); // full list
  const [loadingDevice, setLoadingDevice] = useState(false);
  const [loadingMoreDevice, setLoadingMoreDevice] = useState(false);
  const [devicePermission, setDevicePermission] = useState(null);
  const deviceLoadedRef = useRef(false);

  // Chatyy family
  const familyLoadedRef = useRef(false);
  const [familyUsers, setFamilyUsers] = useState(() => { try { const c = getCachedEntrySync('contacts_on_chatyy_v1')?.data; return Array.isArray(c) ? c : []; } catch { return []; } });
  const [loadingFamily, setLoadingFamily] = useState(false);

  // Chatyy registered contacts (emails/phones found on Chatyy)
  const [registeredEmails, setRegisteredEmails] = useState(new Set());
  const [registeredPhones, setRegisteredPhones] = useState(() => new Map()); // last-8-digits -> account email
  // [2026-10-13 contacts-invite] true quando o check_contacts da agenda rodou
  // (com consentimento) → "não registrado" passa a ser um fato, não um "não sei".
  const [deviceChecked, setDeviceChecked] = useState(false);
  // Folha "Convidar para o Chatyy" ({ name, phone, email, _my?, _dc? }).
  const [inviteTarget, setInviteTarget] = useState(null);
  // Meus contatos: e-mail do contato → e-mail da conta Chatyy ('' = sem conta).
  // UM check_contacts em lote (≤500) só p/ os ainda desconhecidos; cache 24h.
  const [myChatyyStatus, setMyChatyyStatus] = useState(() => {
    try { const c = getCachedEntrySync('contacts_chatyy_status_v1')?.data; return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch { return {}; }
  });
  const myCheckRef = useRef(false);

  // Sync
  const [syncing, setSyncing] = useState(false);
  // [2026-10-07 app-feel-nav] pull-to-refresh nativo (RefreshControl) na lista.
  const [ptrRefreshing, setPtrRefreshing] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  // Server-side search results for Chatyy users
  const [searchResults, setSearchResults] = useState([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const searchTimerRef = useRef(null);
  // Monotonic request id so a slower in-flight family search can't overwrite
  // the results of a newer query (search.js uses the same guard).
  const searchReqRef = useRef(0);

  // Debounced local search
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchDebounceRef = useRef(null);

  // [WA-parity 2026-05-31] Share-contact (send a contact card to a chat).
  // shareContactCard holds the {name,phone,email} card being shared; when
  // set, a lightweight conversation picker modal opens so the user can pick
  // which chat receives the contact message (chatSend type 'contact').
  const [shareContactCard, setShareContactCard] = useState(null);
  const [shareConvList, setShareConvList] = useState([]);
  const [shareConvLoading, setShareConvLoading] = useState(false);
  const [shareConvSearch, setShareConvSearch] = useState('');
  const [shareSendingId, setShareSendingId] = useState(null);

  const TABS = [
    { key: 'my', label: t('contacts.tabMy') },
    { key: 'device', label: t('contacts.tabDevice') },
    { key: 'family', label: t('contacts.onChatyy') || 'No Chatyy' },
  ];

  useEffect(() => { loadContacts(); }, []);

  // Debounce search input (300ms)
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [search]);

  // Debounced server search for family tab
  useEffect(() => {
    if (activeTab !== 'family') return;
    if (debouncedSearch.length < 3) {
      setSearchResults([]);
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      const reqId = ++searchReqRef.current;
      setSearchingUsers(true);
      try {
        // [2026-10-12 chatlist-wa] search_onemundo_users is a stub that always
        // answers [] — use the real directory search (same as chat-new).
        const r = await api.chatyyUsers(debouncedSearch, 30);
        // Stale-response guard: a previous, slower query must not clobber the
        // results of a newer one the user has since typed.
        if (reqId !== searchReqRef.current) return;
        // [WAVE 63 #fam-crash] Same defense as loadFamilyUsers — never let
        // `data` be a non-array. Filter out null entries that could crash the
        // family tab merge in filteredItems below.
        if (r?.success) {
          const _rows = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.data?.users) ? r.data.users : []);
          const safe = _rows.filter(u => u && typeof u === 'object' && u.email);
          try { console.log('[FAMILIA-DIAG][contacts][searchUsers][ok]', 'count=', safe.length); } catch {}
          setSearchResults(safe);
        } else {
          // Endpoint reachable but returned a non-success (e.g. action not yet
          // deployed, or a 4xx wrapped in success:false). Clear server results
          // so filteredItems falls back to the local familyUsers filter —
          // never silently render an empty family tab on a backend hiccup.
          try { console.log('[FAMILIA-DIAG][contacts][searchUsers][not_success]', r?.message); } catch {}
          setSearchResults([]);
        }
      } catch (e) {
        // Network throw / missing endpoint. Drop server results so the local
        // filter shows through (graceful fallback), but only for the latest
        // request so we don't wipe a newer successful response.
        if (reqId !== searchReqRef.current) return;
        try { console.log('[FAMILIA-DIAG][contacts][searchUsers][error]', e?.message); } catch {}
        setSearchResults([]);
      } finally {
        if (reqId === searchReqRef.current) setSearchingUsers(false);
      }
    }, 200);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [debouncedSearch, activeTab]);

  useEffect(() => {
    try { console.log('[FAMILIA-DIAG][contacts][activeTab]', activeTab); } catch {}
    if (activeTab === 'device' && !deviceLoadedRef.current) loadDeviceContacts();
    if (activeTab === 'family' && !familyLoadedRef.current) { familyLoadedRef.current = true; loadFamilyUsers(); }
  }, [activeTab]);

  useEffect(() => {
    try { console.log('[FAMILIA-DIAG][contacts][mount]'); } catch {}
  }, []);

  const loadContacts = async () => {
    setLoadError(false);
    // Show cached contacts instantly
    const cached = _contactsDisk();
    if (cached) {
      setContacts(cached);
      setLoading(false);
    }
    try {
      const r = await api.getContactsList();
      if (r.success) {
        setContacts(r.data || []);
        setCache('contacts', r, 7776000000).catch(() => {});
      }
    } catch {
      if (!contacts.length) setLoadError(true);
    } finally { setLoading(false); }
  };

  // Load device contacts with batching + cache
  const loadDeviceContacts = async () => {
    if (!Contacts || Platform.OS === 'web') {
      setDevicePermission('web');
      return;
    }

    // Check cache first
    if (_deviceContactsCache && (Date.now() - _deviceContactsCacheTime < DEVICE_CACHE_TTL)) {
      setDeviceContactsAll(_deviceContactsCache);
      setDeviceContacts(_deviceContactsCache.slice(0, BATCH_SIZE));
      deviceLoadedRef.current = true;
      setDevicePermission('granted');
      return;
    }

    setLoadingDevice(true);
    try {
      if (!Contacts.requestPermissionsAsync || !Contacts.getContactsAsync) {
        setDevicePermission('web');
        setLoadingDevice(false);
        return;
      }
      const { status } = await Contacts.requestPermissionsAsync();
      setDevicePermission(status);
      if (status !== 'granted') {
        setLoadingDevice(false);
        return;
      }
      const fields = [];
      if (Contacts.Fields?.Name) fields.push(Contacts.Fields.Name);
      if (Contacts.Fields?.Emails) fields.push(Contacts.Fields.Emails);
      if (Contacts.Fields?.PhoneNumbers) fields.push(Contacts.Fields.PhoneNumbers);
      const opts = { fields };
      if (Contacts.SortTypes?.FirstName) opts.sort = Contacts.SortTypes.FirstName;
      const { data } = await Contacts.getContactsAsync(opts);
      const allContacts = data || [];

      // Cache in memory
      _deviceContactsCache = allContacts;
      _deviceContactsCacheTime = Date.now();
      deviceLoadedRef.current = true;

      // Show first batch immediately
      setDeviceContactsAll(allContacts);
      setDeviceContacts(allContacts.slice(0, BATCH_SIZE));

      // Load rest in background after a tick
      if (allContacts.length > BATCH_SIZE) {
        setLoadingMoreDevice(true);
        setTimeout(() => {
          setDeviceContacts(allContacts);
          setLoadingMoreDevice(false);
        }, 100);
      }

      // Check which contacts are registered on Chatyy
      // [Play compliance 2026-06-04] Esse upload de emails+telefones da lista
      // de contatos era o ÚNICO caminho SEM a declaração em destaque — exata
      // violação que removeu o app da Play Store ("uploading contact list to
      // chatyy.com.br without prominent disclosure"). Agora exige o mesmo
      // consentimento explícito do fluxo de descoberta (ensureContactsConsent,
      // persistido). Sem consentimento: a lista local continua visível, só o
      // matching "quem tem Chatyy" fica desligado.
      try {
        const { ensureContactsConsent } = require('../services/contactSync');
        const consented = await ensureContactsConsent(t);
        if (!consented) throw new Error('consent_denied');
        const emails = allContacts
          .map(dc => dc.emails?.[0]?.email)
          .filter(Boolean)
          .map(e => e.toLowerCase());
        const phones = [];
        for (const dc of allContacts) for (const pn of (dc.phoneNumbers || [])) { if (pn?.number) phones.push(pn.number); }
        if (emails.length > 0 || phones.length > 0) {
          // server caps each list at 500 (400 above that → nothing matched).
          const r = await api.checkContacts(emails.slice(0, 500), phones.slice(0, 500));
          if (r.success && r.data?.registered) {
            const regEmails = (r.data.registered || []).map(u => String(u?.email || u || '').toLowerCase()).filter(Boolean);
            setRegisteredEmails(new Set(regEmails));
            // [2026-10-12 chatlist-wa] Phone matches come back keyed by the
            // ACCOUNT email + the number WE sent — most agenda entries have no
            // e-mail, so matching by e-mail alone left "No Chatyy" empty.
            const regPhones = new Map();
            for (const u of (r.data.registered || [])) {
              const d = String(u?.phone || '').replace(/\D/g, '');
              if (d.length >= 8 && u?.email) regPhones.set(d.slice(-8), String(u.email).toLowerCase());
            }
            setRegisteredPhones(regPhones);
            setDeviceChecked(true);
          }
        }
      } catch (err) {
        console.warn('Failed to check registered contacts:', err);
      }
    } catch (err) {
      console.warn('Failed to load device contacts:', err);
      setDevicePermission('web');
    } finally { setLoadingDevice(false); }
  };

  // Load Chatyy family users
  // [2026-10-12 chatlist-wa] "No Chatyy" tab was ALWAYS empty: it called
  // list_onemundo_users, which the server deliberately answers with [] (no
  // global user enumeration). Build it like WhatsApp's "Contatos no Chatyy"
  // instead, from sources that are allowed + real:
  //   1. my agenda matched on Chatyy (contactSync cache / sync — native, only
  //      after the user's contact-upload consent; never prompts from here);
  //   2. people I already have a direct chat with (they are on Chatyy);
  //   3. web: the same chatyy_users directory chat-new already shows.
  const loadFamilyUsers = async () => {
    setLoadingFamily(true);
    const meLc = String(myEmailRef.current || '').toLowerCase();
    const byEmail = new Map();
    const add = (email, name, extra) => {
      const em = String(email || '').trim().toLowerCase();
      if (!em || em === meLc || !em.includes('@')) return;
      const prev = byEmail.get(em);
      const nm = String(name || '').trim();
      byEmail.set(em, {
        ...(prev || {}),
        ...(extra || {}),
        email: em,
        // humanize handles ("bruno.demo" → "Bruno Demo"), same as the chat list
        display_name: (prev && prev.display_name) || api.emailToDisplayName(nm || em) || nm || em,
      });
    };
    try {
      if (Platform.OS !== 'web') {
        try {
          const cs = require('../services/contactSync');
          let res = await cs.getCachedContacts();
          if (!res || !Array.isArray(res.chatyContacts) || res.chatyContacts.length === 0) {
            // silent: never shows the consent sheet / OS prompt from this tab.
            const r2 = await cs.syncContacts(false, t, { silent: true }).catch(() => null);
            if (r2 && Array.isArray(r2.chatyContacts) && r2.chatyContacts.length) res = r2;
          }
          for (const c of (res?.chatyContacts || [])) add(c.email, c.name, { phone: c.phone || '', _fromAgenda: true });
        } catch {}
      }
      try {
        const r = await api.chatConversations('', false);
        const convs = Array.isArray(r?.data) ? r.data : (r?.data?.conversations || []);
        for (const c of convs) {
          if (!c || c.type !== 'direct') continue;
          const peer = c.other_email || c.contact_email
            || ((c.members || []).map(m => (typeof m === 'string' ? m : m?.email)).find(e => e && String(e).toLowerCase() !== meLc));
          add(peer, c.display_name || c.name, { _hasChat: true });
        }
      } catch {}
      if (Platform.OS === 'web') {
        try {
          const r = await api.chatyyUsers('', 200);
          for (const u of (r?.data?.users || [])) add(u.email, u.name);
        } catch {}
      }
      const list = Array.from(byEmail.values()).sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''), undefined, { sensitivity: 'base' }));
      setFamilyUsers(list);
      try { setCache('contacts_on_chatyy_v1', list, 6 * 3600 * 1000); } catch {}
    } catch {
      setFamilyUsers(prev => (Array.isArray(prev) ? prev : []));
    } finally { setLoadingFamily(false); }
  };

  // Add device contact to my contacts. Previous code swallowed save errors
  // AND still showed the "Added" alert — silent data loss. Now: only claim
  // success when the save actually succeeded; otherwise surface a real error.
  const addDeviceContact = useCallback(async (dc) => {
    const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim();
    const email = dc.emails?.[0]?.email || '';
    const phone = dc.phoneNumbers?.[0]?.number || '';
    if (!email && !name) return;
    try {
      const r = await api.saveContact({ name, email, phone, group: '' });
      if (!r?.success) throw new Error(r?.message || 'save_failed');
      loadContacts();
      Alert.alert(t('contacts.added'), t('contacts.addedMessage', { name: name || email }));
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', t('contacts.saveError') || 'Não foi possível salvar este contato.');
      if (__DEV__) console.warn('[contacts.addDeviceContact]', e?.message);
    }
  }, [t]);

  // Add Chatyy user to my contacts — same fix as above.
  const addFamilyContact = useCallback(async (user) => {
    // [WAVE 63 #fam-crash] Guard against missing email — previously
    // `user.email.split` crashed when search returned a phone-only row.
    const safeEmail = (user?.email || '').toString();
    const safeName = (user?.display_name || '').toString();
    if (!safeEmail) {
      Alert.alert(t('common.error') || 'Erro', t('contacts.saveError') || 'Não foi possível salvar este contato.');
      return;
    }
    try {
      const r = await api.saveContact({
        name: safeName || safeEmail.split('@')[0] || safeEmail,
        email: safeEmail,
        phone: (user?.phone || '').toString(),
        group: 'Chatyy',
      });
      if (!r?.success) throw new Error(r?.message || 'save_failed');
      loadContacts();
      Alert.alert(t('contacts.added'), t('contacts.addedMessage', { name: safeName || safeEmail }));
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', t('contacts.saveError') || 'Não foi possível salvar este contato.');
      if (__DEV__) console.warn('[contacts.addFamilyContact]', e?.message);
    }
  }, [t]);

  // Sync all device contacts to my contacts
  const syncAllDeviceContacts = async () => {
    const allDc = deviceContactsAll.length > 0 ? deviceContactsAll : deviceContacts;
    if (allDc.length === 0) return;
    const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()));
    const toSync = allDc.filter(dc => {
      const email = dc.emails?.[0]?.email;
      return email && !existingEmails.has(email.toLowerCase());
    });
    if (toSync.length === 0) {
      Alert.alert(t('contacts.synced'), t('contacts.allSynced'));
      return;
    }
    Alert.alert(
      t('contacts.syncTitle'),
      t('contacts.syncMessage', { count: toSync.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('contacts.sync'),
          onPress: async () => {
            setSyncing(true);
            let imported = 0;
            for (const dc of toSync) {
              const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim();
              const email = dc.emails?.[0]?.email || '';
              const phone = dc.phoneNumbers?.[0]?.number || '';
              if (!email) continue;
              try {
                await api.saveContact({ name, email, phone, group: '' });
                imported++;
              } catch {}
            }
            setSyncing(false);
            loadContacts();
            Alert.alert(t('common.success'), t('contacts.importedCount', { count: imported }));
          },
        },
      ]
    );
  };

  // vCard export (web)
  const handleExportVCard = () => {
    if (Platform.OS !== 'web') return;
    const vcf = contacts.map(contactToVCard).join('\r\n');
    const blob = new Blob([vcf], { type: 'text/vcard;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = t('contacts.exportFilename');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Process a vCard File (shared between iOS DocumentPicker path and web <input type="file">)
  const processVCardFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    const parsed = parseVCards(text);
    if (parsed.length === 0) {
      if (Platform.OS === 'web') window.alert(t('contacts.noContactsInFile'));
      else Alert.alert(t('contacts.noContactsInFile'));
      return;
    }
    let imported = 0;
    for (const c of parsed) {
      try { await api.saveContact({ name: c.name, email: c.email, phone: c.phone, group: c.group }); imported++; } catch {}
    }
    if (imported > 0) loadContacts();
    const msg = t('contacts.contactsImported', { count: imported });
    if (Platform.OS === 'web') window.alert(msg);
    else Alert.alert(t('common.success') || '', msg);
  };

  // vCard import (web) — kept for the existing buttons; uses native <input> ref when available
  const webFileInputRef = useRef(null);
  const handleImportVCard = () => {
    if (Platform.OS !== 'web') return;
    // Prefer the rendered <input type="file"> if present; fallback to dynamic creation
    if (webFileInputRef.current) {
      webFileInputRef.current.value = '';
      webFileInputRef.current.click();
      return;
    }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.vcf,.vcard,text/vcard';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      await processVCardFile(file);
    };
    input.click();
  };

  // Auto-discover from sent emails
  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const r = await api.discoverContacts();
      if (r.success && r.data?.length > 0) {
        const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()));
        const newOnes = r.data.filter(c => !existingEmails.has((c.email || '').toLowerCase()));
        if (newOnes.length === 0) {
          Alert.alert(t('contacts.discoverTitle'), t('contacts.allDiscovered'));
          return;
        }
        Alert.alert(
          t('contacts.contactsFound'),
          t('contacts.contactsFoundMessage', { count: newOnes.length }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('contacts.import'),
              onPress: async () => {
                let imported = 0;
                for (const c of newOnes) {
                  try { await api.saveContact({ name: c.name || '', email: c.email, phone: '', group: '' }); imported++; } catch {}
                }
                if (imported > 0) loadContacts();
                Alert.alert(t('common.success'), t('contacts.importedCount', { count: imported }));
              },
            },
          ]
        );
      } else {
        Alert.alert(t('contacts.discoverTitle'), t('contacts.noNewContacts'));
      }
    } catch {
      Alert.alert(t('common.error'), t('contacts.fetchError'));
    } finally { setDiscovering(false); }
  };

  // Toggle favorite on a contact
  const toggleFavorite = useCallback(async (contact) => {
    const newFav = !contact.favorite;
    setContacts(prev => prev.map(c =>
      c.email === contact.email ? { ...c, favorite: newFav } : c
    ));
    try {
      await api.saveContact({
        id: contact.id,
        name: contact.name || '',
        email: contact.email || '',
        phone: contact.phone || '',
        group: contact.group || '',
        notes: contact.notes || '',
        favorite: newFav,
      });
    } catch {
      setContacts(prev => prev.map(c =>
        c.email === contact.email ? { ...c, favorite: !newFav } : c
      ));
    }
  }, []);

  const handleEditContact = useCallback((c) => {
    setForm({ name: c.name || '', email: c.email || '', phone: c.phone || '', group: c.group || '', notes: c.notes || '', favorite: !!c.favorite });
    setEmailError('');
    setEditContact(c);
    setShowAdd(true);
  }, []);

  // Tap on a contact opens the public profile screen (Instagram/WhatsApp
  // pattern). Falls back to the edit form if there's no email to route on.
  const handleOpenProfile = useCallback((c) => {
    const email = c?.email;
    if (!email) { handleEditContact(c); return; }
    try {
      router.push(`/u/${encodeURIComponent(email)}`);
    } catch {
      handleEditContact(c);
    }
  }, [router, handleEditContact]);

  // Long-press shows an action sheet — the WhatsApp "row hold" affordance.
  // Avoids forcing the user into the profile screen just to send a message.
  const [quickMenu, setQuickMenu] = useState(null);
  // [2026-10-17 wa-polish] refs p/ a folha de ações (handleDelete é declarado depois).
  const _deleteContactRef = useRef(null);
  const _isSavedContactRef = useRef(() => false);
  _isSavedContactRef.current = (em) => {
    const k = String(em || '').toLowerCase();
    return !!k && Array.isArray(contacts) && contacts.some(x => String(x?.email || '').toLowerCase() === k);
  };
  const handleQuickActions = useCallback((c) => {
    const email = c?.email;
    if (!email) { handleEditContact(c); return; }
    const display = c.name || c.display_name || email.split('@')[0];
    // Lazy haptic — same pattern used elsewhere (chat list long-press).
    try {
      const Haptics = require('../services/haptics').HapticsCompat;
      Haptics.selectionAsync?.().catch?.(() => {});
    } catch {}
    const goChat = () => require('../services/openConversation').openConversation(`/chat-conversation?name=${encodeURIComponent(display)}&email=${encodeURIComponent(email)}`);
    const goCall = () => require('../services/openConversation').openConversation(`/chat-conversation?email=${encodeURIComponent(email)}&startCall=audio`);
    const goVideo = () => require('../services/openConversation').openConversation(`/chat-conversation?email=${encodeURIComponent(email)}&startCall=video`);
    const goEmail = () => router.push(`/compose?to=${encodeURIComponent(email)}`);
    const goEdit = () => handleEditContact(c);
    // [WA-parity 2026-05-31] Share this contact's card to a conversation.
    const goShare = () => openShareContact(c);

    if (Platform.OS === 'web') {
      // Browser has no native action sheet — push straight to profile so
      // the user gets the same Mensagem/Ligar/Vídeo/Email row.
      try { router.push(`/u/${encodeURIComponent(email)}`); } catch {}
      return;
    }
    // [2026-10-16 polish-r2] Folha P&B do design system (era Alert.alert com
    // 7 botões: no Android o diálogo do sistema só mostra 3 e cortava o resto).
    setQuickMenu({
      display, email,
      items: [
        { key: 'msg', label: t('profile.message') || 'Mensagem', icon: IconMessageSquare, onPress: goChat },
        { key: 'call', label: t('profile.call') || 'Ligar', icon: IconPhone, onPress: goCall },
        { key: 'video', label: t('profile.video') || 'Vídeo', icon: IconVideo, onPress: goVideo },
        { key: 'email', label: t('profile.email') || 'E-mail', icon: IconMail, onPress: goEmail },
        // [WA-parity 2026-05-31] "Compartilhar contato" — sends a contact card.
        { key: 'share', label: t('contacts.shareContact') || 'Compartilhar contato', icon: IconSend, onPress: goShare },
        { key: 'edit', label: t('contacts.editContact') || 'Editar', icon: IconEdit, onPress: goEdit },
        // [2026-10-17 wa-polish] "Excluir" (vermelho, por último) só p/ contato salvo —
        // substitui a lixeira fixa que poluía cada linha.
        ...(_isSavedContactRef.current(email) && _deleteContactRef.current ? [
          { key: 'delete', label: t('contacts.delete') || t('common.delete') || 'Excluir', icon: IconTrash, destructive: true, onPress: () => setTimeout(() => { try { _deleteContactRef.current && _deleteContactRef.current(email); } catch {} }, Platform.OS === 'ios' ? 420 : 0) },
        ] : []),
      ],
    });
  }, [router, handleEditContact, t]);

  // [WA-parity 2026-05-31] Build a contact card payload from any contact-ish
  // object (my contact, device contact, family user) and open the chat picker.
  // The card shape ({name,phone,email}) matches chat-conversation's contact
  // renderer + sendContact, so the receiver sees a real contact bubble.
  const openShareContact = useCallback((c) => {
    const name = (c?.name || c?.display_name || '').toString().trim();
    const email = (c?.email || c?.emails?.[0]?.email || '').toString().trim();
    const phone = (c?.phone || c?.phoneNumbers?.[0]?.number || '').toString().trim();
    if (!name && !email && !phone) {
      const warn = t('chatConv.contactNeedsField') || 'Contato sem dados para compartilhar';
      if (Platform.OS === 'web') { try { window.alert(warn); } catch {} }
      else Alert.alert(t('common.error') || 'Erro', warn);
      return;
    }
    const card = { name: name || phone || email, phone, email };
    setShareContactCard(card);
    setShareConvSearch('');
    setShareConvList([]);
    setShareConvLoading(true);
    (async () => {
      try {
        const r = await api.chatConversations();
        const list = api.apiList(r, 'conversations', 'chats');
        list.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
        setShareConvList(list);
      } catch {
        setShareConvList([]);
      } finally {
        setShareConvLoading(false);
      }
    })();
  }, [t]);

  // [WA-parity 2026-05-31] Send the held contact card to the picked chat as a
  // type:'contact' message, then navigate into that conversation (WhatsApp
  // flow). Idempotent: guarded by shareSendingId so a double-tap can't
  // double-send.
  const handleSendContactToConv = useCallback(async (conv) => {
    if (!conv?.id || !shareContactCard || shareSendingId) return;
    setShareSendingId(conv.id);
    try {
      const content = JSON.stringify(shareContactCard);
      const clientMessageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const r = await api.chatSend(conv.id, content, 'contact', null, null, null, tempId, clientMessageId);
      if (!r?.success) throw new Error(r?.message || 'send_failed');
      setShareContactCard(null);
      require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { id: String(conv.id), name: conv.name || conv.display_name || conv.other_email || '', ...(conv.type ? { type: conv.type } : {}) } });
    } catch (e) {
      const msg = t('chatConv.contactSendError') || 'Não foi possível enviar o contato';
      if (Platform.OS === 'web') { try { window.alert(msg); } catch {} }
      else Alert.alert(t('common.error') || 'Erro', msg);
      if (__DEV__) console.warn('[contacts.handleSendContactToConv]', e?.message);
    } finally {
      setShareSendingId(null);
    }
  }, [shareContactCard, shareSendingId, router, t]);

  const handleSave = async () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!form.email.trim() || !emailRegex.test(form.email.trim())) {
      setEmailError(t('contacts.invalidEmail'));
      return;
    }
    setEmailError('');
    setSaving(true);
    try {
      const data = { ...form };
      if (editContact?.id) data.id = editContact.id;
      const r = await api.saveContact(data);
      if (r.success) {
        setShowAdd(false); setEditContact(null);
        setForm({ name: '', email: '', phone: '', group: '', notes: '', favorite: false });
        loadContacts();
      }
    } catch {} finally { setSaving(false); }
  };

  // [bug 2026-05-21 #contact-delete] Previous version was fire-and-forget:
  // any backend hiccup (timeout, 401 silent, cache write fail) left the
  // contact on screen with zero feedback, then `loadContacts()` re-fetched
  // the same row and the user thought "nothing happened".
  //
  // Now: optimistic remove (snap the row out immediately for instant UX),
  // call API, restore + surface error on failure. Also invalidates the
  // local 90d cache so next cold-start matches reality.
  const handleDelete = useCallback((email) => {
    if (!email) return;
    const target = (email || '').toLowerCase();
    const doDelete = async () => {
      // Snapshot for rollback. setContacts is sync — UI updates this tick.
      let snapshot = null;
      setContacts(prev => {
        snapshot = prev;
        return prev.filter(c => (c.email || '').toLowerCase() !== target);
      });
      try {
        const r = await api.deleteContact(email);
        if (!r?.success) throw new Error(r?.message || 'delete_failed');
        // Invalidate the on-disk contacts cache so we don't resurrect on
        // next cold-start. Best-effort — failure here is non-fatal.
        try { await setCache('contacts', { success: true, data: snapshot.filter(c => (c.email || '').toLowerCase() !== target) }, 7776000000); } catch {}
        // Refetch in the background to reconcile (e.g. groups list refresh
        // when the deleted contact was the last of its group).
        loadContacts();
      } catch (err) {
        // Restore and tell the user — silent failure is what made this
        // bug invisible for so long.
        if (snapshot) setContacts(snapshot);
        if (Platform.OS === 'web') {
          try { window.alert(t('contacts.deleteError') || t('common.error') || 'Não foi possível excluir.'); } catch {}
        } else {
          Alert.alert(t('common.error') || 'Erro', t('contacts.deleteError') || 'Não foi possível excluir o contato. Tente novamente.');
        }
        if (__DEV__) console.warn('[contacts.handleDelete]', err?.message);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(t('contacts.deleteConfirmWeb'))) doDelete();
    } else {
      Alert.alert(t('contacts.deleteTitle'), t('contacts.deleteMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('contacts.delete'), style: 'destructive', onPress: doDelete },
      ]);
    }
  }, [t]);
  _deleteContactRef.current = handleDelete;

  const groups = [...new Set(contacts.map(c => c.group).filter(Boolean))];
  const contactEmailSet = useMemo(() => new Set(contacts.map(c => (c.email || '').toLowerCase())), [contacts]);
  const isContactSaved = useCallback((email) => contactEmailSet.has((email || '').toLowerCase()), [contactEmailSet]);

  // ── [2026-10-13 contacts-invite] Quem dos MEUS contatos tem Chatyy ─────────
  // Fontes (sem chamada extra quando dá): "No Chatyy" em cache (agenda casada +
  // DMs) e o mapa persistido; só os desconhecidos vão num check_contacts em
  // lote (os mesmos dados que já estão na agenda do servidor). Desconhecido =
  // comportamento antigo (abre perfil) — nunca rotulamos "Convidar" no chute.
  const familyEmailSet = useMemo(() => new Set((Array.isArray(familyUsers) ? familyUsers : [])
    .map(u => String(u?.email || '').toLowerCase()).filter(Boolean)), [familyUsers]);
  useEffect(() => {
    if (myCheckRef.current || !Array.isArray(contacts) || contacts.length === 0) return;
    const lc = (v) => String(v || '').trim().toLowerCase();
    const digits = (v) => String(v || '').replace(/\D/g, '');
    const meLc = lc(myEmailRef.current);
    const unknown = contacts.filter(c => {
      const e = lc(c?.email);
      return e && e.includes('@') && e !== meLc && !familyEmailSet.has(e) && !Object.prototype.hasOwnProperty.call(myChatyyStatus, e);
    }).slice(0, 500);
    if (unknown.length === 0) return;
    myCheckRef.current = true;
    (async () => {
      try {
        const emails = unknown.map(c => lc(c.email));
        const phones = unknown.map(c => String(c?.phone || '')).filter(p => digits(p).length >= 8).slice(0, 500);
        const r = await api.checkContacts(emails, phones);
        if (!r?.success || !Array.isArray(r?.data?.registered)) return;
        const regE = new Set();
        const regP = new Map();
        for (const u of r.data.registered) {
          const em = lc(u?.email || u);
          if (!em) continue;
          regE.add(em);
          const d = digits(u?.phone);
          if (d.length >= 8) regP.set(d.slice(-8), em);
        }
        setMyChatyyStatus(prev => {
          const next = { ...(prev || {}) };
          for (const c of unknown) {
            const e = lc(c.email);
            const d = digits(c.phone);
            next[e] = regE.has(e) ? e : ((d.length >= 8 && regP.get(d.slice(-8))) || '');
          }
          try { setCache('contacts_chatyy_status_v1', next, 24 * 3600 * 1000); } catch {}
          return next;
        });
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, familyEmailSet]);

  // { state: 'yes'|'no'|'unknown', email? } — email = conta Chatyy p/ abrir.
  const myChatyyOf = useCallback((c) => {
    const e = String(c?.email || '').trim().toLowerCase();
    if (!e) return { state: 'unknown' };
    if (familyEmailSet.has(e) || e === String(myEmailRef.current || '').toLowerCase()) return { state: 'yes', email: e };
    const v = myChatyyStatus[e];
    if (typeof v === 'string') return v ? { state: 'yes', email: v } : { state: 'no' };
    return { state: 'unknown' };
  }, [familyEmailSet, myChatyyStatus]);

  const openMyInvite = useCallback((c) => {
    try { prefetchInviteRef(); } catch {}
    setInviteTarget({ name: c?.name || '', phone: c?.phone || '', email: c?.email || '', _my: c });
  }, []);
  const openDeviceInvite = useCallback((dc) => {
    try { prefetchInviteRef(); } catch {}
    setInviteTarget({
      name: dc?.name || `${dc?.firstName || ''} ${dc?.lastName || ''}`.trim(),
      phone: dc?.phoneNumbers?.[0]?.number || '',
      email: dc?.emails?.[0]?.email || '',
      _dc: dc,
    });
  }, []);
  // Toque em "Meus contatos": sem Chatyy → folha de convite; com/desconhecido → perfil.
  const handleMyContactPress = useCallback((c) => {
    const st = myChatyyOf(c);
    if (st.state === 'no') { openMyInvite(c); return; }
    handleOpenProfile(st.email && st.email !== String(c?.email || '').toLowerCase() ? { ...c, email: st.email } : c);
  }, [myChatyyOf, openMyInvite, handleOpenProfile]);
  const handleMyContactLongPress = useCallback((c) => {
    const st = myChatyyOf(c);
    if (st.state === 'no') { openMyInvite(c); return; }
    handleQuickActions(st.email && st.email !== String(c?.email || '').toLowerCase() ? { ...c, email: st.email } : c);
  }, [myChatyyOf, openMyInvite, handleQuickActions]);

  // Filter logic per tab - uses debouncedSearch
  const filteredItems = useMemo(() => {
    const q = debouncedSearch.toLowerCase();

    if (activeTab === 'device') {
      const src = deviceContacts;
      if (!q) return src;
      return src.filter(dc => {
        const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim();
        const email = dc.emails?.[0]?.email || '';
        const phone = dc.phoneNumbers?.[0]?.number || '';
        return name.toLowerCase().includes(q) || email.toLowerCase().includes(q) || phone.includes(q);
      });
    }

    if (activeTab === 'family') {
      // [WAVE 63 #fam-crash] Defensive: filter null/undefined users and
      // normalize all string fields BEFORE calling .toLowerCase()/.includes().
      // Previous code did `u.email.toLowerCase()` which crashes when backend
      // (listOneMundoUsers + searchOneMundoUsers) returns rows without `email`
      // — happened post-WAVE 53 when search results from a phone-only user
      // came back with email:null.
      try { console.log('[FAMILIA-DIAG][contacts][filter] familyUsers=', familyUsers?.length, 'searchResults=', searchResults?.length, 'q=', q ? '[search]' : '[empty]'); } catch {}
      const safeUsers = (Array.isArray(familyUsers) ? familyUsers : []).filter(u => u && typeof u === 'object');
      const local = q ? safeUsers.filter(u => {
        const name = (u?.display_name || '').toString().toLowerCase();
        const email = (u?.email || '').toString().toLowerCase();
        const phone = (u?.phone || '').toString();
        return name.includes(q) || email.includes(q) || phone.includes(q);
      }) : safeUsers;

      const safeSearchResults = (Array.isArray(searchResults) ? searchResults : []).filter(s => s && typeof s === 'object');
      if (safeSearchResults.length > 0) {
        const localEmails = new Set(local.map(u => (u?.email || '').toString().toLowerCase()).filter(Boolean));
        const merged = [...local];
        for (const sr of safeSearchResults) {
          const srEmail = (sr?.email || '').toString().toLowerCase();
          if (srEmail && !localEmails.has(srEmail)) {
            merged.push({ email: srEmail, display_name: (sr?.name || '').toString(), match_type: sr?.match_type });
          }
        }
        return merged;
      }
      return local;
    }

    // My contacts
    return contacts.filter(c => {
      if (activeGroup !== 'all' && (c.group || '') !== activeGroup) return false;
      if (!q) return true;
      return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
    });
  }, [activeTab, debouncedSearch, deviceContacts, familyUsers, searchResults, contacts, activeGroup]);

  // Favorites section
  const favoriteContacts = useMemo(() => {
    if (activeTab !== 'my') return [];
    const q = debouncedSearch.toLowerCase();
    return contacts.filter(c => {
      if (!c.favorite) return false;
      if (activeGroup !== 'all' && (c.group || '') !== activeGroup) return false;
      if (!q) return true;
      return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
    });
  }, [contacts, activeTab, debouncedSearch, activeGroup]);

  // Non-favorite contacts with alphabetical sections.
  // Sections layout:
  //   1. "Adicionados recentemente" — contacts whose added_at (preferred)
  //      or created_at is within the last 7 days. If neither timestamp is
  //      populated on any contact (older backend payloads), we fall back
  //      to top 5 by created_at desc so the section still has something
  //      meaningful instead of going empty. Capped at 5 either way.
  //   2. A…Z (and "#" bucket) — every non-favorite, including those that
  //      already appear in "Recently added" (parity with WhatsApp, which
  //      surfaces recents at the top and still keeps them under their
  //      alphabetical letter).
  const alphabeticalSections = useMemo(() => {
    if (activeTab !== 'my') return [];
    const nonFav = filteredItems.filter(c => !c.favorite);
    const enrich = (c) => ({
      ...c,
      _lastContactedFormatted: c.last_contacted ? `${t('contacts.lastContacted')}: ${formatLastContacted(c.last_contacted, t)}` : '',
    });

    // Recently added — last 7 days by added_at|created_at.
    const SEVEN_D_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const tsOf = (c) => {
      const raw = c.added_at || c.created_at || '';
      if (!raw) return 0;
      const n = typeof raw === 'number' ? raw : Date.parse(raw);
      return Number.isFinite(n) ? n : 0;
    };
    const withTs = nonFav.map(c => ({ c, ts: tsOf(c) })).filter(x => x.ts > 0);
    let recent = withTs.filter(x => now - x.ts <= SEVEN_D_MS);
    if (recent.length === 0 && withTs.length > 0) {
      // Fallback: top 5 by created_at desc when nothing falls in the 7d
      // window (e.g. all contacts imported long ago).
      recent = [...withTs].sort((a, b) => b.ts - a.ts).slice(0, 5);
    } else {
      recent = recent.sort((a, b) => b.ts - a.ts).slice(0, 5);
    }
    const recentData = recent.map(x => enrich(x.c));

    // [2026-10-13 contacts-invite] Quem comprovadamente NÃO tem Chatyy sai das
    // letras e vai p/ uma seção final "Convidar para o Chatyy" (WhatsApp).
    const inviteData = [];
    const onChatyyOrUnknown = [];
    for (const c of nonFav) {
      if (myChatyyOf(c).state === 'no') inviteData.push(enrich(c));
      else onChatyyOrUnknown.push(c);
    }

    // Alphabetical buckets.
    const grouped = {};
    for (const c of onChatyyOrUnknown) {
      const letter = ((c.name || c.email || '?')[0] || '?').toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(enrich(c));
    }
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    const alpha = Object.keys(grouped).sort().map(letter => ({
      title: letter,
      data: grouped[letter].sort((a, b) =>
        collator.compare((a.name || a.email || ''), (b.name || b.email || ''))
      ),
    }));

    const out = [];
    if (recentData.length > 0) {
      out.push({
        title: t('contacts.recentlyAdded') || 'Adicionados recentemente',
        key: '__recent__',
        data: recentData,
      });
    }
    const all = out.concat(alpha);
    if (inviteData.length > 0) {
      all.push({
        title: t('contacts.inviteToChatyy') || 'Convidar para o Chatyy',
        key: '__invite__',
        data: inviteData.sort((a, b) => collator.compare((a.name || a.email || ''), (b.name || b.email || ''))),
      });
    }
    return all;
  }, [filteredItems, activeTab, t, myChatyyOf]);

  // Render favorite contact (larger avatar). Tap = profile (Instagram/WA
  // pattern) so the favorites row stops being a "shortcut to the edit
  // form" — that's what long-press is for.
  const renderFavoriteContact = (c, i) => (
    <TouchableOpacity
      key={c.id || i}
      style={[s.favoriteItem]}
      onPress={() => handleMyContactPress(c)}
      onLongPress={() => handleMyContactLongPress(c)}
      delayLongPress={350}
      activeOpacity={0.6}
    >
      <AvatarCircle name={c.name || c.email} email={c.email} size={56} />
      <Text style={[s.favoriteName, { color: colors.text }]} numberOfLines={1}>
        {(c.name || c.email || '').split(' ')[0]}
      </Text>
    </TouchableOpacity>
  );

  // FlatList render items for device tab
  const renderDeviceItem = useCallback(({ item: dc }) => {
    const email = dc.emails?.[0]?.email || '';
    const saved = email ? isContactSaved(email) : false;
    let _phoneEmail = null;
    for (const p of (dc.phoneNumbers || [])) {
      const d = String(p?.number || '').replace(/\D/g, '');
      if (d.length >= 8 && registeredPhones.has(d.slice(-8))) { _phoneEmail = registeredPhones.get(d.slice(-8)); break; }
    }
    const isRegistered = (email ? registeredEmails.has(email.toLowerCase()) : false) || !!_phoneEmail;
    return (
      <DeviceContactRow
        dc={dc}
        colors={colors}
        saved={saved}
        onAdd={addDeviceContact}
        t={t}
        isRegistered={isRegistered}
        chatyyEmail={_phoneEmail || ''}
        onOpenProfile={handleOpenProfile}
        onQuickActions={handleQuickActions}
        checked={deviceChecked}
        onInvite={openDeviceInvite}
      />
    );
  }, [colors, isContactSaved, addDeviceContact, t, registeredEmails, registeredPhones, handleOpenProfile, handleQuickActions, deviceChecked, openDeviceInvite]);

  // Device contacts split into "On Chatyy" and "Invite to Chatyy" sections
  const deviceSections = useMemo(() => {
    if (activeTab !== 'device' || filteredItems.length === 0 || (!deviceChecked && registeredEmails.size === 0 && registeredPhones.size === 0)) return [];
    const onChatyy = [];
    const invite = [];
    for (const dc of filteredItems) {
      const email = dc.emails?.[0]?.email || '';
      const byPhone = (dc.phoneNumbers || []).some(p => {
        const d = String(p?.number || '').replace(/\D/g, '');
        return d.length >= 8 && registeredPhones.has(d.slice(-8));
      });
      if ((email && registeredEmails.has(email.toLowerCase())) || byPhone) {
        onChatyy.push(dc);
      } else {
        invite.push(dc);
      }
    }
    const sections = [];
    if (onChatyy.length > 0) sections.push({ title: t('contacts.onChatyy') || 'On Chatyy', key: 'on_chatyy', data: onChatyy });
    if (invite.length > 0) sections.push({ title: t('contacts.inviteToChatyy') || 'Invite to Chatyy', key: 'invite', data: invite });
    return sections;
  }, [activeTab, filteredItems, registeredEmails, registeredPhones, deviceChecked, t]);

  // Render section header for device tab
  const renderDeviceSectionHeader = useCallback(({ section }) => (
    <View style={[s.sectionHeader, { backgroundColor: colors.background }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {section.key === 'on_chatyy' && (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
        )}
        <Text style={[s.sectionHeaderText, { color: section.key === 'on_chatyy' ? colors.success : colors.textTertiary, fontWeight: '700' }]}>
          {section.title} ({section.data.length})
        </Text>
      </View>
    </View>
  ), [colors]);

  // Share invite link
  // [2026-10-13 contacts-invite] mesmo texto/link (com ref) da folha de convite.
  const handleShareInvite = useCallback(async () => {
    try { await shareInviteLink(t); } catch {}
  }, [t]);

  // FlatList render items for family tab
  const renderFamilyItem = useCallback(({ item: user }) => {
    // [WAVE 63 #fam-crash] Defensive guard against null/empty email — every
    // downstream consumer (FamilyUserRow, isContactSaved, addFamilyContact)
    // assumed `user.email` was a string. Crash repro: search returns a row
    // where email is undefined → `isContactSaved(undefined).toLowerCase()`.
    if (!user || typeof user !== 'object') return null;
    const safeUser = { ...user, email: (user.email || '').toString() };
    const saved = safeUser.email ? isContactSaved(safeUser.email) : false;
    return (
      <FamilyUserRow
        user={safeUser}
        colors={colors}
        saved={saved}
        onAdd={addFamilyContact}
        t={t}
        onOpenProfile={handleOpenProfile}
        onQuickActions={handleQuickActions}
      />
    );
  }, [colors, isContactSaved, addFamilyContact, t, handleOpenProfile, handleQuickActions]);

  // My contacts render for SectionList
  const renderMyContactItem = useCallback(({ item }) => {
    return (
      <MyContactRow
        c={item}
        colors={colors}
        onEdit={handleEditContact}
        onDelete={handleDelete}
        onToggleFav={toggleFavorite}
        onOpenProfile={handleMyContactPress}
        onQuickActions={handleMyContactLongPress}
        notOnChatyy={myChatyyOf(item).state === 'no'}
        onInvite={openMyInvite}
      />
    );
  }, [colors, handleEditContact, handleDelete, toggleFavorite, handleMyContactPress, handleMyContactLongPress, myChatyyOf, openMyInvite]);

  // Section list header renderer — alphabet letter with subtle brand accent
  // bar so each section reads as a navigation anchor (iOS Contacts pattern).
  const renderSectionHeader = useCallback(({ section }) => (
    <View style={[s.sectionHeader, { backgroundColor: colors.background, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
      <View style={{ width: 3, height: 12, borderRadius: 1.5, backgroundColor: colors.primary, opacity: 0.6 }} />
      <Text style={[s.sectionHeaderText, { color: colors.textTertiary }]}>{section.title}</Text>
    </View>
  ), [colors]);

  const deviceKeyExtractor = useCallback((item, index) => item.id || String(index), []);
  const familyKeyExtractor = useCallback((item, index) => item.email || String(index), []);
  // SectionList note: a contact can appear in BOTH the "Recently added"
  // section and its alphabetical letter section, which would yield
  // duplicate keys if we keyed solely off item.id. Prefix the key with
  // the section index so each rendered row is unique.
  const myKeyExtractor = useCallback((item, index) => `${item.id || item.email || ''}-${index}`, []);

  // [2026-10-15 native-contacts] Lista nativa de "Meus contatos". Desligar:
  // globalThis.__chatyy_native_contacts = false. Erro → volta à SectionList.
  const [_nativeContactsFailed, _setNativeContactsFailed] = useState(() => !!globalThis.__chatyy_native_contacts_failed);
  const _useNativeContacts = Platform.OS !== 'web' && !_nativeContactsFailed && nativeContactsEnabled();
  const _onNativeContactsFailure = useCallback((msg) => {
    try { globalThis.__chatyy_native_contacts_failed = true; console.warn('[native-contacts] fallback SectionList:', msg); try { require('../services/crashReporter').reportNativeFallback('native_contacts', msg); } catch {} } catch {}
    _setNativeContactsFailed(true);
  }, []);
  const _nativeMyList = useMemo(() => {
    if (!_useNativeContacts || activeTab !== 'my') return { rows: [], meta: new Map() };
    const delLabel = t('common.delete');
    const inviteLabel = t('chat.invite') || 'Convidar';
    return buildFlatRows(
      alphabeticalSections,
      (sec) => ({
        t: String(sec.title || ''),
        bar: true, up: true, fs: 13, fw: 600, ls: 0.3,
        pt: 12, pb: 8, ph: Spacing.lg,
        ix: /^[A-Z#]$/.test(String(sec.title || '')) && !sec.key ? String(sec.title) : '',
      }),
      (c) => {
        const email = String(c.email || '').toLowerCase();
        const notOn = myChatyyOf(c).state === 'no';
        return {
          key: c.id || email,
          row: {
            t: c.name || email,
            tw: 600,
            sb: email,
            s2: c.phone ? String(c.phone) : '',
            s2t: 2,
            ch: c.group ? String(c.group) : '',
            me: c.last_contacted ? String(c._lastContactedFormatted || '') : '',
            tiles: contactTile(c.email, c.name || c.email),
            av: 40,
            pl: notOn ? inviteLabel : '',
            st: c.favorite ? 2 : 1,
            // [2026-10-17 wa-polish] sem lixeira fixa na linha (WhatsApp): apagar =
            // deslizar ("sw") ou segurar → "Excluir" na folha de ações.
            tr: false,
            sw: delLabel,
            lp: true,
            a11y: [c.name || email, email].filter(Boolean).join(', '),
          },
        };
      },
    );
  }, [_useNativeContacts, activeTab, alphabeticalSections, myChatyyOf, t]);
  const _nativeContactColors = useMemo(() => ({
    dark: !!isDark,
    bg: colors.background, text: colors.text, sub: colors.textSecondary, faint: colors.textTertiary,
    hair: colors.borderLight, primary: colors.primary, onPrimary: colors.onPrimary,
    warning: colors.warning, error: colors.error,
    press: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)',
    chipBg: colors.primaryLight, chipText: colors.primary,
    border: colors.border, indexText: colors.primary,
  }), [colors, isDark]);
  const _nativeContactMetrics = useMemo(() => ({
    padH: Spacing.lg, padV: Spacing.md, gap: Spacing.md, minH: 64,
    nameSize: FontSize.lg, subSize: FontSize.sm, sub2Size: FontSize.xs, metaSize: 10,
  }), []);
  const _onNativeContactAction = useCallback((action, c) => {
    if (action === 'star') toggleFavorite(c);
    else if (action === 'delete') handleDelete(c.email);
    else if (action === 'pill' || action === 'pillLong') openMyInvite(c);
  }, [toggleFavorite, handleDelete, openMyInvite]);
  const _onNativeContactsRefresh = async () => {
    setPtrRefreshing(true);
    try { await loadContacts(); } finally { setPtrRefreshing(false); }
  };

  const isLoading = (activeTab === 'my' && loading) ||
    (activeTab === 'device' && loadingDevice) ||
    (activeTab === 'family' && loadingFamily);

  // Device/family empty component
  const renderDeviceEmpty = useCallback(() => {
    if (loadingDevice) return <ListSkeleton count={6} />;
    if (devicePermission === 'denied') {
      return (
        <View style={s.emptyContainer}>
          <IconSmartphone size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('contacts.permissionRequired')}</Text>
          <Text style={[s.emptyHint, { color: colors.textTertiary }]}>{t('contacts.permissionMessage')}</Text>
          {/* [2026-10-17 android-wa] negado de vez → só os Ajustes destravam (WhatsApp) */}
          <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg }}>
            <TouchableOpacity
              onPress={() => { try { require('react-native').Linking.openSettings().catch(() => {}); } catch {} }}
              style={[s.bigActionBtn, { backgroundColor: colors.primary }]}
              accessibilityRole="button"
            >
              <Text style={[s.bigActionBtnText, { color: colors.onPrimary }]}>{t('common.openSettings')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    if (devicePermission === 'web') {
      return (
        <View style={s.emptyContainer}>
          <IconSmartphone size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('contacts.syncWithDevice')}</Text>
          <Text style={[s.emptyHint, { color: colors.textTertiary }]}>{t('contacts.syncWebMessage')}</Text>
          <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg }}>
            <TouchableOpacity onPress={handleImportVCard} style={[s.bigActionBtn, { backgroundColor: colors.primary }]}>
              <IconUpload size={18} color={colors.onPrimary} />
              <Text style={[s.bigActionBtnText, { color: colors.onPrimary }]}>{t('contacts.importVcf')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    if (filteredItems.length === 0) {
      return (
        <View style={s.emptyContainer}>
          <IconUsers size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
          <Text style={[s.emptyTitle, { color: colors.textTertiary }]}>{t('contacts.noDeviceContacts')}</Text>
          <Text style={[s.emptyHint, { color: colors.textTertiary }]}>
            {debouncedSearch ? t('contacts.tryDifferentSearch') : t('contacts.allowAccess')}
          </Text>
        </View>
      );
    }
    return null;
  }, [loadingDevice, devicePermission, filteredItems.length, debouncedSearch, colors, t]);

  const renderFamilyEmpty = useCallback(() => {
    if (loadingFamily) return <ListSkeleton count={6} />;
    if (filteredItems.length === 0) {
      return (
        <View style={s.emptyContainer}>
          <IconUsers size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
          <Text style={[s.emptyTitle, { color: colors.textTertiary }]}>{t('contacts.noMembersFound')}</Text>
          <Text style={[s.emptyHint, { color: colors.textTertiary }]}>
            {debouncedSearch ? t('contacts.tryDifferentSearch') : t('contacts.noOtherAccounts')}
          </Text>
        </View>
      );
    }
    return null;
  }, [loadingFamily, filteredItems.length, debouncedSearch, colors, t]);

  // Device list header (searching users indicator)
  const renderFamilyHeader = useCallback(() => {
    if (searchingUsers) {
      return (
        <View style={{ paddingVertical: Spacing.sm, alignItems: 'center' }}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      );
    }
    return null;
  }, [searchingUsers, colors]);

  // Loading more indicator for device contacts
  const renderDeviceFooter = useCallback(() => {
    if (loadingMoreDevice) {
      return (
        <View style={{ paddingVertical: Spacing.md, alignItems: 'center' }}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[{ fontSize: FontSize.xs, color: colors.textTertiary, marginTop: 4 }]}>
            {t('contacts.loadingMore')}
          </Text>
        </View>
      );
    }
    return null;
  }, [loadingMoreDevice, colors, t]);

  // [2026-10-14 vis-audit] Um só "adicionar": lista vazia já mostra o CTA grande
  // "Adicionar contato" → o "+" do topo some nesse estado (volta quando há contatos).
  const _openAddContact = () => { setForm({ name: '', email: '', phone: '', group: '', notes: '', favorite: false }); setEditContact(null); setShowAdd(true); };
  const _emptyHasAddCta = activeTab === 'my' && !isLoading && contacts.length === 0 && !debouncedSearch;
  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {/* [2026-10-07 app-feel-nav] Nativo: header do sistema + barra de busca
          NATIVA (UISearchController no iOS / SearchView Material no Android)
          no lugar do <View> com TextInput. Web mantém o header/busca antigos. */}
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          title: `${t('contacts.title')}${contacts.length > 0 ? ` (${contacts.length})` : ''}`,
          headerRight: () => (_emptyHasAddCta ? null :
            <HeaderIconButton
              onPress={() => { setForm({ name: '', email: '', phone: '', group: '', notes: '', favorite: false }); setEditContact(null); setShowAdd(true); }}
              accessibilityLabel={t('contacts.addContact') || 'Add contact'}
            >
              <IconPlus size={24} color={colors.text} />
            </HeaderIconButton>
          ),
          search: {
            placeholder: activeTab === 'device' ? t('contacts.searchDevice') : activeTab === 'family' ? t('contacts.searchFamily') : t('contacts.searchMy'),
            onChangeText: (e) => setSearch(e?.nativeEvent?.text ?? ''),
            onCancelButtonPress: () => setSearch(''),
            onClose: () => setSearch(''),
          },
        })} />
      ) : (
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => { if (Platform.OS === "web" && window.parent !== window) { try { window.parent.postMessage({ type: "close-side-panel", route: "/contacts" }, "*"); } catch {} } else { router.back(); } }} style={s.backBtn}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>
          {t('contacts.title')}{contacts.length > 0 ? ` (${contacts.length})` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 4, minWidth: 36 }}>
          {!_emptyHasAddCta && <PressableScale
            onPress={() => { setForm({ name: '', email: '', phone: '', group: '', notes: '', favorite: false }); setEditContact(null); setShowAdd(true); }}
            style={[s.addBtn, { backgroundColor: colors.primary + '14', borderRadius: 18, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }]}
            activeOpacity={0.7}
            accessibilityLabel={t('contacts.addContact') || 'Add contact'}
            accessibilityRole="button"
          >
            <IconPlus size={20} color={colors.primary} />
          </PressableScale>}
        </View>
      </View>
      )}

      {/* [2026-10-08 header-inset-all] iOS: header translúcido (busca nativa) →
          abas/ações/lista começavam em y=0 SOB nav bar + busca. O wrapper mede o
          safe-area real da view e empurra todo o bloco p/ baixo do header. */}
      <NativeHeaderSafeArea>
      {/* Tabs */}
      <View style={[s.tabBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[s.tab, activeTab === tab.key && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[s.tabText, { color: activeTab === tab.key ? colors.primary : colors.textSecondary }]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search (web — no nativo a busca está no header) */}
      {!USE_NATIVE_HEADER && (
      <View style={[s.searchRow, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
        <IconSearch size={16} color={colors.textTertiary} />
        <TextInput
          style={[s.searchInput, { color: colors.text }]}
          value={search}
          onChangeText={setSearch}
          placeholder={activeTab === 'device' ? t('contacts.searchDevice') : activeTab === 'family' ? t('contacts.searchFamily') : t('contacts.searchMy')}
          placeholderTextColor={colors.textTertiary}
          returnKeyType="search" clearButtonMode="while-editing" autoCorrect={false} autoCapitalize="none" enablesReturnKeyAutomatically
        />
      </View>
      )}

      {/* Group filter for My Contacts tab */}
      {activeTab === 'my' && groups.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.groupTabs, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]} contentContainerStyle={s.groupTabsContent}>
          <TouchableOpacity
            style={[s.groupTab, { backgroundColor: activeGroup === 'all' ? colors.primary : (colors.surfaceVariant || colors.borderLight) }]}
            onPress={() => setActiveGroup('all')}
          >
            <Text style={[s.groupTabText, { color: activeGroup === 'all' ? colors.onPrimary : colors.text }]}>{t('contacts.all')}</Text>
          </TouchableOpacity>
          {groups.map(g => (
            <TouchableOpacity
              key={g}
              style={[s.groupTab, { backgroundColor: activeGroup === g ? colors.primary : (colors.surfaceVariant || colors.borderLight) }]}
              onPress={() => setActiveGroup(g)}
            >
              <Text style={[s.groupTabText, { color: activeGroup === g ? colors.onPrimary : colors.text }]}>{g}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Action bar for current tab */}
      {activeTab === 'my' && (
        <View style={[s.actionBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          {Platform.OS === 'web' && (
            <>
              {/* Hidden native HTML file input — wired to handleImportVCard via webFileInputRef */}
              <View style={{ width: 0, height: 0, overflow: 'hidden' }}>
                <input
                  ref={webFileInputRef}
                  type="file"
                  accept=".vcf,text/vcard"
                  aria-label={t('contacts.importVcfWebHint')}
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e?.target?.files?.[0];
                    await processVCardFile(file);
                    if (e?.target) e.target.value = '';
                  }}
                />
              </View>
              <TouchableOpacity
                onPress={handleImportVCard}
                style={[s.actionBtn, { borderColor: colors.border }]}
                accessibilityLabel={t('contacts.importVcfWebHint')}
                accessibilityRole="button"
              >
                <IconUpload size={14} color={colors.primary} />
                <Text style={[s.actionBtnText, { color: colors.primary }]}>{t('contacts.importVCard')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleExportVCard} style={[s.actionBtn, { borderColor: colors.border }]}>
                <IconDownload size={14} color={colors.textSecondary} />
                <Text style={[s.actionBtnText, { color: colors.textSecondary }]}>{t('contacts.export')}</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity onPress={handleDiscover} disabled={discovering} style={[s.actionBtn, { borderColor: colors.border }]}>
            {discovering ? <ActivityIndicator size="small" color={colors.primary} /> : <IconRefresh size={14} color={colors.primary} />}
            <Text style={[s.actionBtnText, { color: colors.primary }]}>{t('contacts.discover')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {activeTab === 'device' && Contacts && deviceContacts.length > 0 && (
        <View style={[s.actionBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={syncAllDeviceContacts}
            disabled={syncing}
            style={[s.actionBtn, { borderColor: colors.border, backgroundColor: colors.surfaceVariant || 'transparent' }]}
          >
            {syncing ? <ActivityIndicator size="small" color={colors.primary} /> : <IconRefresh size={14} color={colors.primary} />}
            <Text style={[s.actionBtnText, { color: colors.primary }]}>{t('contacts.syncAll')}</Text>
          </TouchableOpacity>
          <Text style={[s.actionHint, { color: colors.textTertiary }]}>
            {t('contacts.deviceCount', { count: deviceContactsAll.length || deviceContacts.length })}
          </Text>
        </View>
      )}

      {activeTab === 'family' && familyUsers.length > 0 && (
        <View style={[s.actionBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={loadFamilyUsers} style={[s.actionBtn, { borderColor: colors.border }]}>
            <IconRefresh size={14} color={colors.primary} />
            <Text style={[s.actionBtnText, { color: colors.primary }]}>{t('contacts.refresh')}</Text>
          </TouchableOpacity>
          <Text style={[s.actionHint, { color: colors.textTertiary }]}>
            {t('contacts.familyCount', { count: familyUsers.length })}
          </Text>
        </View>
      )}

      {/* Content */}
      <FadeSlideIn>
      {loadError && contacts.length === 0 ? (
        <View style={s.emptyContainer}>
          <View style={[s.emptyIconCircle, { backgroundColor: isDark ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.08)' }]}>
            <IconX size={40} color={colors.error} />
          </View>
          <Text style={[s.emptyTitle, { color: colors.text, fontWeight: '700', fontSize: FontSize.xl }]}>
            {t('common.error')}
          </Text>
          <Text style={[s.emptyHint, { color: colors.textSecondary, lineHeight: 20 }]}>
            {t('contacts.loadErrorDesc')}
          </Text>
          <View style={s.emptyCTARow}>
            <TouchableOpacity
              style={[s.emptyCTABtn, { backgroundColor: colors.primary }]}
              onPress={loadContacts}
              activeOpacity={0.8}
            >
              <IconRefresh size={16} color={colors.onPrimary} />
              <Text style={[s.emptyCTAText, { color: colors.onPrimary }]}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : isLoading && contacts.length === 0 && deviceContacts.length === 0 && familyUsers.length === 0 ? (
        <ListSkeleton count={8} />
      ) : activeTab === 'my' && _useNativeContacts ? (
        <NativeContactList
          rows={_nativeMyList.rows}
          meta={_nativeMyList.meta}
          colors={_nativeContactColors}
          metrics={_nativeContactMetrics}
          isDark={isDark}
          indexEnabled={!debouncedSearch}
          refreshEnabled
          refreshing={ptrRefreshing}
          onRefresh={_onNativeContactsRefresh}
          bottomInset={40 + insets.bottom}
          onPress={handleMyContactPress}
          onLongPress={handleMyContactLongPress}
          onAction={_onNativeContactAction}
          onFailure={_onNativeContactsFailure}
          header={favoriteContacts.length > 0 ? (
            <View style={[s.favoritesSection, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.favoritesSectionTitle, { color: colors.text }]}>
                <IconStar size={14} color={colors.warning} /> {t('contacts.favorites')}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.favoritesScroll}>
                {favoriteContacts.map((c, i) => renderFavoriteContact(c, i))}
              </ScrollView>
            </View>
          ) : null}
          empty={
            <ContactsEmptyState
              colors={colors}
              isDark={isDark}
              t={t}
              searching={!!debouncedSearch}
              onAdd={_openAddContact}
              onClearSearch={() => setSearch('')}
              onSync={() => setActiveTab('device')}
              onDiscover={handleDiscover}
              onFindFriends={() => setActiveTab('family')}
            />
          }
        />
      ) : activeTab === 'my' ? (
        <SectionList
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
          refreshControl={Platform.OS !== 'web' ? (
            <RefreshControl
              refreshing={ptrRefreshing}
              onRefresh={async () => { setPtrRefreshing(true); try { await loadContacts(); } finally { setPtrRefreshing(false); } }}
              tintColor={colors.textSecondary}
              colors={[colors.text]}
              progressBackgroundColor={colors.surface}
            />
          ) : undefined}
          sections={alphabeticalSections}
          keyExtractor={myKeyExtractor}
          renderItem={renderMyContactItem}
          renderSectionHeader={renderSectionHeader}
          removeClippedSubviews={Platform.OS !== 'web'}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={11}
          stickySectionHeadersEnabled
          ListHeaderComponent={
            <>
              {/* Favorites section */}
              {favoriteContacts.length > 0 && (
                <View style={[s.favoritesSection, { borderBottomColor: colors.borderLight }]}>
                  <Text style={[s.favoritesSectionTitle, { color: colors.text }]}>
                    <IconStar size={14} color={colors.warning} /> {t('contacts.favorites')}
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.favoritesScroll}>
                    {favoriteContacts.map((c, i) => renderFavoriteContact(c, i))}
                  </ScrollView>
                </View>
              )}
            </>
          }
          ListEmptyComponent={
            <ContactsEmptyState
              colors={colors}
              isDark={isDark}
              t={t}
              searching={!!debouncedSearch}
              onAdd={_openAddContact}
              onClearSearch={() => setSearch('')}
              onSync={() => setActiveTab('device')}
              onDiscover={handleDiscover}
              onFindFriends={() => setActiveTab('family')}
            />
          }
          contentContainerStyle={[s.list, { paddingBottom: 40 + insets.bottom }]}
        />
      ) : activeTab === 'device' ? (
        deviceSections.length > 0 ? (
          <SectionList
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            sections={deviceSections}
            keyExtractor={deviceKeyExtractor}
            renderItem={renderDeviceItem}
            renderSectionHeader={renderDeviceSectionHeader}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={11}
            stickySectionHeadersEnabled
            ListEmptyComponent={renderDeviceEmpty}
            ListFooterComponent={
              <>
                {renderDeviceFooter()}
                {/* Invite button at bottom */}
                <TouchableOpacity
                  onPress={handleShareInvite}
                  style={[s.inviteBtn, { borderColor: colors.primary }]}
                  activeOpacity={0.7}
                >
                  <IconPlus size={14} color={colors.primary} />
                  <Text style={[s.inviteBtnText, { color: colors.primary }]}>{t('contacts.shareInviteLink') || 'Share invite link'}</Text>
                </TouchableOpacity>
              </>
            }
            contentContainerStyle={[s.list, { paddingBottom: 40 + insets.bottom }]}
            removeClippedSubviews={Platform.OS !== 'web'}
          />
        ) : (
          <FlatList
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            data={filteredItems}
            keyExtractor={deviceKeyExtractor}
            renderItem={renderDeviceItem}
            ListEmptyComponent={renderDeviceEmpty}
            ListFooterComponent={renderDeviceFooter}
            contentContainerStyle={[s.list, { paddingBottom: 40 + insets.bottom }]}
            removeClippedSubviews={Platform.OS !== 'web'}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={11}
          />
        )
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
          data={filteredItems}
          keyExtractor={familyKeyExtractor}
          renderItem={renderFamilyItem}
          ListHeaderComponent={renderFamilyHeader}
          ListEmptyComponent={renderFamilyEmpty}
          contentContainerStyle={[s.list, { paddingBottom: 40 + insets.bottom }]}
          removeClippedSubviews={Platform.OS !== 'web'}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={11}
        />
      )}
      </FadeSlideIn>
      </NativeHeaderSafeArea>

      {/* Add/Edit Modal */}
      <Modal visible={showAdd} animationType="slide" transparent onRequestClose={() => setShowAdd(false)}>
        <DragSheetRoot>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
        <TouchableOpacity style={[s.overlay, { backgroundColor: 'transparent' }]} onPress={() => setShowAdd(false)} activeOpacity={1}>
          <DragBackdrop drag={_addDrag} color="rgba(0,0,0,0.45)" />
          <DragPanel drag={_addDrag} onStartShouldSetResponder={() => true} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
            <View style={[s.modalHeader, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.modalTitle, { color: colors.text }]}>
                {editContact ? t('contacts.editContact') : t('contacts.newContact')}
              </Text>
              <TouchableOpacity onPress={() => setShowAdd(false)}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <DragScroll drag={_addDrag}><ScrollView style={s.formBody} contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={[s.formFieldLabel, { color: colors.textSecondary }]}>{t('contacts.nameLabel')}</Text>
              <View style={s.formRow}>
                <IconUser size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.name} onChangeText={v => setForm(p => ({ ...p, name: v }))}
                  placeholder={t('contacts.namePlaceholder')} placeholderTextColor={colors.textTertiary}
                  textContentType="name" autoComplete="name" autoCapitalize="words" returnKeyType="next" clearButtonMode="while-editing"
                  accessibilityLabel={t('contacts.nameLabel')} />
              </View>
              <Text style={[s.formFieldLabel, { color: colors.textSecondary }]}>
                {t('contacts.emailLabel')} <Text style={{ color: colors.error }}>*</Text>
              </Text>
              <View style={s.formRow}>
                <IconMail size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: emailError ? colors.error : colors.border }]}
                  value={form.email} onChangeText={v => { setForm(p => ({ ...p, email: v })); if (emailError) setEmailError(''); }}
                  placeholder={t('contacts.emailPlaceholder')} placeholderTextColor={colors.textTertiary}
                  keyboardType="email-address" autoCapitalize="none"
                  textContentType="emailAddress" autoComplete="email" autoCorrect={false} returnKeyType="next" clearButtonMode="while-editing"
                  accessibilityLabel={t('contacts.emailLabel')} />
              </View>
              {emailError ? (
                <Text style={{ color: colors.error, fontSize: 12, marginTop: 4, marginLeft: 28 }}>
                  {emailError}
                </Text>
              ) : null}
              <Text style={[s.formFieldLabel, { color: colors.textSecondary }]}>{t('contacts.phoneLabel')}</Text>
              <View style={s.formRow}>
                <IconPhone size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.phone} onChangeText={v => setForm(p => ({ ...p, phone: v }))}
                  placeholder={t('contacts.phonePlaceholder')} placeholderTextColor={colors.textTertiary}
                  keyboardType="phone-pad"
                  textContentType="telephoneNumber" autoComplete="tel" clearButtonMode="while-editing"
                  accessibilityLabel={t('contacts.phoneLabel')} />
              </View>
              <View style={s.formRow}>
                <IconTag size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.group} onChangeText={v => setForm(p => ({ ...p, group: v }))}
                  placeholder={t('contacts.groupPlaceholder')}
                  placeholderTextColor={colors.textTertiary} />
              </View>

              {/* Section: Trabalho */}
              <Text style={[s.formSectionLabel, { color: colors.textSecondary }]}>{t('contacts.workSection') || 'TRABALHO'}</Text>
              <View style={s.formRow}>
                <View style={{ width: 18, marginRight: 10, alignItems: 'center' }}>
                  <IconBuilding size={16} color={colors.textSecondary} />
                </View>
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.company} onChangeText={v => setForm(p => ({ ...p, company: v }))}
                  placeholder={t('contacts.companyPlaceholder') || 'Empresa'}
                  placeholderTextColor={colors.textTertiary} />
              </View>
              <View style={s.formRow}>
                <View style={{ width: 18, marginRight: 10, alignItems: 'center' }}>
                  <IconBriefcase size={16} color={colors.textSecondary} />
                </View>
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.job_title} onChangeText={v => setForm(p => ({ ...p, job_title: v }))}
                  placeholder={t('contacts.jobTitlePlaceholder') || 'Cargo'}
                  placeholderTextColor={colors.textTertiary} />
              </View>

              {/* Section: Outros */}
              <Text style={[s.formSectionLabel, { color: colors.textSecondary }]}>{t('contacts.otherSection') || 'OUTROS'}</Text>
              <View style={s.formRow}>
                <View style={{ width: 18, marginRight: 10, alignItems: 'center' }}>
                  <IconCake size={16} color={colors.textSecondary} />
                </View>
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.birthday} onChangeText={v => setForm(p => ({ ...p, birthday: v }))}
                  placeholder={t('contacts.birthdayPlaceholder') || 'Aniversário (YYYY-MM-DD)'}
                  placeholderTextColor={colors.textTertiary}
                  accessibilityLabel={t('contacts.birthdayLabel') || t('contacts.birthdayPlaceholder')} />
              </View>
              <View style={s.formRow}>
                <View style={{ width: 18, marginRight: 10, alignItems: 'center' }}>
                  <IconMapPin size={16} color={colors.textSecondary} />
                </View>
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.address} onChangeText={v => setForm(p => ({ ...p, address: v }))}
                  placeholder={t('contacts.addressPlaceholder') || 'Endereço'}
                  placeholderTextColor={colors.textTertiary}
                  accessibilityLabel={t('contacts.addressLabel') || t('contacts.addressPlaceholder')} />
              </View>
              <View style={s.formRow}>
                <View style={{ width: 18, marginRight: 10, alignItems: 'center' }}>
                  <IconGlobe size={16} color={colors.textSecondary} />
                </View>
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.website} onChangeText={v => setForm(p => ({ ...p, website: v }))}
                  placeholder={t('contacts.websitePlaceholder') || 'Site / URL'}
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="url" autoCapitalize="none"
                  textContentType="URL" autoComplete="url" autoCorrect={false} clearButtonMode="while-editing"
                  accessibilityLabel={t('contacts.websiteLabel') || t('contacts.websitePlaceholder')} />
              </View>

              <View style={s.formRow}>
                <IconFileText size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, s.formInputMultiline, { color: colors.text, borderColor: colors.border }]}
                  value={form.notes} onChangeText={v => setForm(p => ({ ...p, notes: v }))}
                  placeholder={t('contacts.notesPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  multiline numberOfLines={3} />
              </View>
              {/* Favorite toggle in form */}
              <TouchableOpacity
                style={[s.favoriteToggleRow, { borderColor: colors.border }]}
                onPress={() => setForm(p => ({ ...p, favorite: !p.favorite }))}
                activeOpacity={0.6}
              >
                <IconStar size={18} color={form.favorite ? colors.warning : colors.textTertiary} />
                <Text style={[s.favoriteToggleText, { color: colors.text }]}>{t('contacts.favorites')}</Text>
                <View style={[s.favoriteToggleCheck, { borderColor: colors.border }, form.favorite && { backgroundColor: colors.warning }]}>
                  {form.favorite && <IconCheck size={12} color="#fff" />}
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: colors.primary }, saving && { opacity: 0.6 }]}
                onPress={handleSave} disabled={saving}
              >
                {saving ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Text style={[s.saveBtnText, { color: colors.onPrimary }]}>{t('contacts.save')}</Text>}
              </TouchableOpacity>
            </ScrollView></DragScroll>
          </DragPanel>
        </TouchableOpacity>
        </KeyboardAvoidingView>
        </DragSheetRoot>
      </Modal>

      {/* [WA-parity 2026-05-31] Share-contact: pick a conversation to send the
          contact card to. Self-contained picker (no extra screen needed). */}
      <Sheet visible={!!quickMenu} onClose={() => setQuickMenu(null)} title={quickMenu?.display} subtitle={quickMenu?.email}>
        <ActionList items={quickMenu?.items || []} onDone={() => setQuickMenu(null)} />
      </Sheet>
      {/* [2026-10-13 contacts-invite] Contato sem Chatyy → convidar (não abre perfil). */}
      <InviteContactSheet
        visible={!!inviteTarget}
        contact={inviteTarget}
        onClose={() => setInviteTarget(null)}
        onEdit={inviteTarget?._my ? () => handleEditContact(inviteTarget._my) : undefined}
        onSave={inviteTarget?._dc && !(inviteTarget.email && isContactSaved(inviteTarget.email)) ? () => addDeviceContact(inviteTarget._dc) : undefined}
      />
      <Modal visible={!!shareContactCard} animationType="slide" transparent onRequestClose={() => setShareContactCard(null)}>
        <DragSheetRoot>
        <TouchableOpacity style={[s.overlay, { backgroundColor: 'transparent' }]} onPress={() => setShareContactCard(null)} activeOpacity={1}>
          <DragBackdrop drag={_shareDrag} color="rgba(0,0,0,0.45)" />
          <DragPanel drag={_shareDrag} onStartShouldSetResponder={() => true} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface, maxHeight: '80%' }]}>
            <View style={[s.modalHeader, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.modalTitle, { color: colors.text }]}>
                {t('contacts.shareContactTo') || 'Enviar contato para'}
              </Text>
              <TouchableOpacity onPress={() => setShareContactCard(null)}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {!!shareContactCard && (
              <View style={[s.contactRow, { borderBottomColor: colors.borderLight }]}>
                <AvatarCircle name={shareContactCard.name} email={shareContactCard.email} size={40} style={{ marginRight: Spacing.md }} />
                <View style={s.contactInfo}>
                  <Text numberOfLines={1} style={[s.contactName, { color: colors.text }]}>{shareContactCard.name}</Text>
                  {!!shareContactCard.email && <Text numberOfLines={1} style={[s.contactEmail, { color: colors.textSecondary }]}>{shareContactCard.email}</Text>}
                  {!!shareContactCard.phone && <Text numberOfLines={1} style={[s.contactPhone, { color: colors.textTertiary }]}>{shareContactCard.phone}</Text>}
                </View>
              </View>
            )}
            <View style={[s.searchRow, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
              <IconSearch size={16} color={colors.textTertiary} />
              <TextInput
                style={[s.searchInput, { color: colors.text }]}
                value={shareConvSearch}
                onChangeText={setShareConvSearch}
                placeholder={t('contacts.searchFamily') || 'Buscar conversa'}
                placeholderTextColor={colors.textTertiary}
              />
            </View>
            {shareConvLoading ? (
              <View style={{ paddingVertical: Spacing.lg, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : (
              <DragScroll drag={_shareDrag}><FlatList
                data={(shareConvSearch.trim()
                  ? shareConvList.filter(cv => (cv.name || cv.display_name || cv.other_email || '').toLowerCase().includes(shareConvSearch.trim().toLowerCase()))
                  : shareConvList)}
                keyExtractor={(item, index) => String(item.id || index)}
                style={{ maxHeight: 380 }}
                ListEmptyComponent={
                  <View style={{ paddingVertical: Spacing.lg, alignItems: 'center' }}>
                    <Text style={[s.emptyHint, { color: colors.textTertiary }]}>{t('chat.noConversations') || 'Nenhuma conversa'}</Text>
                  </View>
                }
                renderItem={({ item: cv }) => {
                  const cName = cv.name || cv.display_name || cv.other_email || '';
                  const busy = shareSendingId === cv.id;
                  return (
                    <PressableRow
                      style={[s.contactRow, { borderBottomColor: colors.borderLight, opacity: busy ? 0.5 : 1 }]}
                      onPress={() => handleSendContactToConv(cv)}
                      disabled={!!shareSendingId}
                      activeOpacity={0.6}
                    >
                      <AvatarCircle name={cName} email={cv.other_email} size={40} style={{ marginRight: Spacing.md }} />
                      <View style={s.contactInfo}>
                        <Text numberOfLines={1} style={[s.contactName, { color: colors.text }]}>{cName}</Text>
                      </View>
                      {busy
                        ? <ActivityIndicator size="small" color={colors.primary} />
                        : <IconSend size={18} color={colors.primary} />}
                    </PressableRow>
                  );
                }}
              /></DragScroll>
            )}
          </DragPanel>
        </TouchableOpacity>
        </DragSheetRoot>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  backBtn: {
    padding: Spacing.sm, marginRight: Spacing.sm, borderRadius: 12,
    minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease' } : {}),
  },
  // Why: deeper letter-spacing (-0.3 → -0.4) tightens the title; matches
  // compose + meeting headers polished earlier this cycle.
  headerTitle: { flex: 1, fontSize: FontSize.xxl, fontWeight: '700', letterSpacing: -0.4 },
  addBtn: { padding: Spacing.sm, borderRadius: 12 },

  // Tabs
  tabBar: {
    flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1, paddingVertical: Spacing.sm + 4, alignItems: 'center', justifyContent: 'center', minHeight: 44,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    ...Platform.select({
      web: { transition: 'all 0.2s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  tabText: { fontSize: 14, fontWeight: '600', letterSpacing: -0.1 },

  // Search
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8, minHeight: 44,
  },
  searchInput: {
    flex: 1, fontSize: FontSize.base,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },

  // Action bar
  actionBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 4,
    borderBottomWidth: StyleSheet.hairlineWidth, flexWrap: 'wrap',
  },
  // [2026-10-13 visual] pílula neutra com hairline (era retângulo c/ borda 1.5)
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: 8, minHeight: 36,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  actionBtnText: { fontSize: 13, fontWeight: '600' },
  actionHint: { fontSize: FontSize.xs, marginLeft: 'auto' },
  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: Spacing.lg, marginVertical: Spacing.md,
    paddingVertical: 12, borderRadius: 12, borderWidth: 1.5,
  },
  inviteBtnText: { fontSize: FontSize.sm, fontWeight: '700' },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { paddingBottom: 40 },

  // Favorites section
  favoritesSection: {
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.md + 2, paddingBottom: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  favoritesSectionTitle: {
    fontSize: 13, fontWeight: '600', marginBottom: Spacing.sm,
    textTransform: 'uppercase', letterSpacing: 0.3,
  },
  favoritesScroll: {
    gap: Spacing.lg, paddingBottom: Spacing.xs,
  },
  favoriteItem: {
    alignItems: 'center', width: 76,
  },
  favoriteName: {
    fontSize: FontSize.xs, fontWeight: '600', marginTop: 6, textAlign: 'center', letterSpacing: -0.1,
  },

  // Section headers (alphabetical)
  // Section header (alphabet letters + "On Chatyy"/"Invite" headers).
  // Why: bumped vertical padding (5→8) so the letter doesn't crowd the row
  // below it. Letter-spacing nudged up (1→1.4) so the all-caps reads as a
  // section label and not a typo.
  sectionHeader: {
    paddingHorizontal: Spacing.lg, paddingVertical: 8, paddingTop: 12,
  },
  sectionHeaderText: {
    fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3,
  },

  // Empty
  emptyContainer: { alignItems: 'center', paddingTop: 48, paddingBottom: 32, paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: 17, fontWeight: '600', marginBottom: Spacing.sm, textAlign: 'center', letterSpacing: -0.2 },
  emptyHint: { fontSize: 15, textAlign: 'center', lineHeight: 20, maxWidth: 300 },
  emptyIconContainer: {
    width: 160, height: 160,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  emptyOuterRing: {
    position: 'absolute', width: 160, height: 160, borderRadius: 80,
    borderWidth: 1.5,
  },
  emptyMiddleRing: {
    position: 'absolute', width: 130, height: 130, borderRadius: 65,
    borderWidth: 1.5,
  },
  emptyIconCircle: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyCTARow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24,
  },
  emptyCTABtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 24, paddingVertical: 13, borderRadius: 14,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'transform 0.15s ease, opacity 0.15s ease', boxShadow: '0 2px 12px rgba(17, 17, 17,0.25)' },
      default: {},
    }),
  },
  emptyCTAText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  bigActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, minHeight: 44,
    borderRadius: BorderRadius.xxl,
  },
  bigActionBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Contact row
  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg, minHeight: 64,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: { transition: 'background-color 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  contactInfo: { flex: 1 },
  // Why: contact name weight 600→700 with deeper letter-spacing reads more
  // like "person" labels in iOS Contacts; email line gets explicit 500 weight
  // so it doesn't disappear next to the bumped name.
  contactName: { fontSize: FontSize.lg, fontWeight: '600', letterSpacing: -0.25 },
  contactEmail: { fontSize: FontSize.sm, marginTop: 2, fontWeight: '400', letterSpacing: -0.05 },
  contactPhone: { fontSize: FontSize.xs, marginTop: 1, opacity: 0.6 },
  lastContactedText: { fontSize: 10, marginTop: 2 },
  deleteBtn: { padding: Spacing.sm },
  starBtn: { padding: Spacing.sm },

  // Group
  groupChip: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginTop: 3 },
  groupChipText: { fontSize: 10, fontWeight: '600' },
  groupTabs: { borderBottomWidth: StyleSheet.hairlineWidth, maxHeight: 52 },
  groupTabsContent: { paddingHorizontal: Spacing.lg, gap: 8, alignItems: 'center', paddingVertical: 10 },
  groupTab: {
    paddingHorizontal: Spacing.md + 2, paddingVertical: 7, minHeight: 32, justifyContent: 'center', borderRadius: 999,
    ...Platform.select({ web: { transition: 'all 0.15s ease', cursor: 'pointer' }, default: {} }),
  },
  groupTabText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Family badge
  familyBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  familyBadgeText: { fontSize: 10, fontWeight: '700' },

  // Add contact button (device/family rows)
  invitePill: {
    borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5,
    marginLeft: Spacing.sm, alignItems: 'center', justifyContent: 'center',
  },
  invitePillText: { fontSize: 13, fontWeight: '600', letterSpacing: 0.1 },
  addContactBtn: {
    width: 34, height: 34, borderRadius: 17, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  savedBadge: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center', opacity: 0.5,
  },

  // Modal
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  modal: {
    borderRadius: 20, width: '90%', maxWidth: 440, maxHeight: '85%', overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 20px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06)' },
      default: { elevation: 16 },
    }),
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  formBody: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg },
  formRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  formSectionLabel: {
    fontSize: 13, fontWeight: '600', letterSpacing: 0.3,
    marginTop: Spacing.sm, marginBottom: Spacing.sm,
  },
  formFieldLabel: {
    fontSize: 12, fontWeight: '600', marginBottom: 4, marginLeft: 28,
  },
  // [2026-10-07 app-feel-ui] Native: iOS-Contacts-style field (hairline
  // underline, no boxed 1.5px web-form border). Web keeps the boxed input.
  formInput: Platform.OS === 'web' ? {
    flex: 1, fontSize: FontSize.lg, borderWidth: 1.5, borderRadius: 14,
    paddingHorizontal: Spacing.md + 2, paddingVertical: 12,
    outlineStyle: 'none', transition: 'border-color 0.2s ease',
  } : {
    flex: 1, fontSize: FontSize.lg, borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth * 2, borderRadius: 0,
    paddingHorizontal: 0, paddingVertical: 10,
  },
  formInputMultiline: {
    minHeight: 64, textAlignVertical: 'top',
  },
  favoriteToggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm, marginBottom: Spacing.md,
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
  },
  favoriteToggleText: { flex: 1, fontSize: FontSize.md, fontWeight: '500' },
  favoriteToggleCheck: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 1.5, borderColor: '#ccc',
    alignItems: 'center', justifyContent: 'center',
  },
  saveBtn: {
    borderRadius: 14, paddingVertical: 14, minHeight: 50, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.md,
    // [2026-10-13 visual] BUG: o `background` gradiente #111 sobrescrevia o
    // backgroundColor (colors.primary) no web → no escuro o texto onPrimary
    // (preto) ficava preto sobre #111 = invisível. Cor vem só do tema agora.
    ...Platform.select({
      web: { cursor: 'pointer' },
      default: {},
    }),
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700', letterSpacing: 0.2 },
});

export default function ContactsScreen() { return <ErrorBoundary><ContactsScreenInner /></ErrorBoundary>; }
