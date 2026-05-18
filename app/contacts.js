import ErrorBoundary from "../components/ErrorBoundary";
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import React from 'react';
import {
  View, FlatList, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView,
  ActivityIndicator, Platform, Modal, Alert, SectionList, Animated, Easing,
} from 'react-native';
// FlashList reverted to FlatList
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { ListSkeleton } from '../components/SkeletonLoader';
import {
  IconArrowLeft, IconUser, IconMail, IconPhone, IconPlus,
  IconX, IconCheck, IconSearch, IconTrash, IconUsers, IconTag,
  IconDownload, IconUpload, IconRefresh, IconSmartphone,
  IconChevronDown, IconChevronUp, IconStar, IconEdit, IconFileText,
  IconBuilding, IconBriefcase, IconCake, IconMapPin, IconGlobe,
  IconMessageSquare, IconVideo,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import SwipeAction from '../components/SwipeAction';
import EmptyStateCard from '../components/EmptyStateCard';

// Try to import expo-contacts (available on native, unavailable on web)
let Contacts = null;
try {
  Contacts = require('expo-contacts');
} catch {}

function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Colors.avatarColors[Math.abs(hash) % Colors.avatarColors.length];
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

const DeviceContactRow = React.memo(({ dc, colors, saved, onAdd, t, isRegistered, onOpenProfile, onQuickActions }) => {
  const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim() || t('contacts.unknown');
  const email = dc.emails?.[0]?.email || '';
  const phone = dc.phoneNumbers?.[0]?.number || '';

  // Registered Chatyy users get the same tap = profile / long-press = quick
  // actions affordance the saved-contacts list has. Non-registered rows stay
  // passive (only the Add button does anything) — there's no profile to open.
  const Wrapper = isRegistered && (onOpenProfile || onQuickActions) ? TouchableOpacity : View;
  const wrapperProps = isRegistered && (onOpenProfile || onQuickActions)
    ? {
        onPress: () => onOpenProfile?.({ email, name, phone }),
        onLongPress: () => onQuickActions?.({ email, name, phone }),
        delayLongPress: 350,
        activeOpacity: 0.6,
      }
    : {};

  return (
    <Wrapper style={[s.contactRow, { borderBottomColor: colors.borderLight }]} {...wrapperProps}>
      <View style={[s.avatar, { backgroundColor: getAvatarColor(name) }]}>
        <Text style={s.avatarText}>{(name?.[0] || '?').toUpperCase()}</Text>
      </View>
      <View style={s.contactInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={[s.contactName, { color: colors.text, flexShrink: 1 }]}>{name}</Text>
          {isRegistered && (
            <View style={[s.groupChip, { backgroundColor: '#dcfce7', marginTop: 0 }]}>
              <Text style={[s.groupChipText, { color: '#16a34a' }]}>Chatyy</Text>
            </View>
          )}
        </View>
        {!!email && <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{email}</Text>}
        {!!phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{phone}</Text>}
      </View>
      {saved ? (
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
  return (
    <TouchableOpacity
      style={[s.contactRow, { borderBottomColor: colors.borderLight }]}
      onPress={() => onOpenProfile?.(user)}
      onLongPress={() => onQuickActions?.(user)}
      delayLongPress={350}
      activeOpacity={0.6}
    >
      <View style={[s.avatar, { backgroundColor: getAvatarColor(user.display_name || user.email) }]}>
        <Text style={s.avatarText}>{(user.display_name || user.email || '?')[0].toUpperCase()}</Text>
      </View>
      <View style={s.contactInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[s.contactName, { color: colors.text }]}>{user.display_name || user.email.split('@')[0]}</Text>
          <View style={[s.familyBadge, { backgroundColor: colors.primary + '18' }]}>
            <IconStar size={10} color={colors.primary} />
            <Text style={[s.familyBadgeText, { color: colors.primary }]}>{t('contacts.family')}</Text>
          </View>
        </View>
        <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{user.email}</Text>
        {!!user.phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{user.phone}</Text>}
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
    </TouchableOpacity>
  );
});

const MyContactRow = React.memo(({ c, colors, onEdit, onDelete, onToggleFav, onOpenProfile, onQuickActions }) => {
  return (
    <SwipeAction
      onSwipeLeft={() => onDelete(c.email)}
      rightContent={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <IconTrash size={18} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Excluir</Text>
        </View>
      }
      style={{ backgroundColor: '#ea4335' }}
    >
    <TouchableOpacity
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
      <TouchableOpacity onPress={() => onToggleFav(c)} style={s.starBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <IconStar size={18} color={c.favorite ? '#FBBC05' : colors.textTertiary} style={c.favorite ? { opacity: 1 } : { opacity: 0.4 }} />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => onDelete(c.email)} style={s.deleteBtn}>
        <IconTrash size={16} color={colors.textTertiary} />
      </TouchableOpacity>
    </TouchableOpacity>
    </SwipeAction>
  );
});

// ---- Polished Empty State for Contacts ----
function ContactsEmptyState({ colors, isDark, t, searching, onAdd }) {
  if (searching) {
    return (
      <EmptyStateCard
        Icon={IconSearch}
        title={t('contacts.noContactsFound') || t('contacts.noContacts')}
        subtitle={t('contacts.tryDifferentSearch')}
        tone="neutral"
      />
    );
  }

  return (
    <EmptyStateCard
      Icon={IconUsers}
      title={t('contacts.noContacts')}
      subtitle={t('contacts.emptyDesc')}
      ctaLabel={t('contacts.addContact')}
      onPress={onAdd}
      tone="primary"
    />
  );
}

function ContactsScreenInner() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState('my');
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
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
  const [familyUsers, setFamilyUsers] = useState([]);
  const [loadingFamily, setLoadingFamily] = useState(false);

  // Chatyy registered contacts (emails/phones found on Chatyy)
  const [registeredEmails, setRegisteredEmails] = useState(new Set());

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  // Server-side search results for Chatyy users
  const [searchResults, setSearchResults] = useState([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const searchTimerRef = useRef(null);

  // Debounced local search
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchDebounceRef = useRef(null);

  const TABS = [
    { key: 'my', label: t('contacts.tabMy') },
    { key: 'device', label: t('contacts.tabDevice') },
    { key: 'family', label: t('contacts.tabFamily') },
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
      setSearchingUsers(true);
      try {
        const r = await api.searchOneMundoUsers(debouncedSearch);
        if (r.success) setSearchResults(r.data || []);
      } catch {} finally { setSearchingUsers(false); }
    }, 200);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [debouncedSearch, activeTab]);

  useEffect(() => {
    if (activeTab === 'device' && !deviceLoadedRef.current) loadDeviceContacts();
    if (activeTab === 'family' && familyUsers.length === 0) loadFamilyUsers();
  }, [activeTab]);

  const loadContacts = async () => {
    setLoadError(false);
    // Show cached contacts instantly
    const cached = await getCached('contacts');
    if (cached?.data) {
      setContacts(cached.data || []);
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
      try {
        const emails = allContacts
          .map(dc => dc.emails?.[0]?.email)
          .filter(Boolean)
          .map(e => e.toLowerCase());
        const phones = allContacts
          .map(dc => dc.phoneNumbers?.[0]?.number)
          .filter(Boolean);
        if (emails.length > 0 || phones.length > 0) {
          const r = await api.checkContacts(emails, phones);
          if (r.success && r.data?.registered) {
            const regEmails = (r.data.registered || []).map(u => (u.email || u).toLowerCase());
            setRegisteredEmails(new Set(regEmails));
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
  const loadFamilyUsers = async () => {
    setLoadingFamily(true);
    try {
      const r = await api.listOneMundoUsers();
      if (r.success) setFamilyUsers(r.data || []);
    } catch {} finally { setLoadingFamily(false); }
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
    try {
      const r = await api.saveContact({
        name: user.display_name || user.email.split('@')[0],
        email: user.email,
        phone: user.phone || '',
        group: 'Chatyy',
      });
      if (!r?.success) throw new Error(r?.message || 'save_failed');
      loadContacts();
      Alert.alert(t('contacts.added'), t('contacts.addedMessage', { name: user.display_name || user.email }));
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
  const handleQuickActions = useCallback((c) => {
    const email = c?.email;
    if (!email) { handleEditContact(c); return; }
    const display = c.name || c.display_name || email.split('@')[0];
    // Lazy haptic — same pattern used elsewhere (chat list long-press).
    try {
      const Haptics = require('expo-haptics');
      Haptics.selectionAsync?.().catch?.(() => {});
    } catch {}
    const goChat = () => router.push(`/chat-conversation?name=${encodeURIComponent(display)}&email=${encodeURIComponent(email)}`);
    const goCall = () => router.push(`/chat-conversation?email=${encodeURIComponent(email)}&startCall=audio`);
    const goVideo = () => router.push(`/chat-conversation?email=${encodeURIComponent(email)}&startCall=video`);
    const goEmail = () => router.push(`/compose?to=${encodeURIComponent(email)}`);
    const goEdit = () => handleEditContact(c);

    if (Platform.OS === 'web') {
      // Browser has no native action sheet — push straight to profile so
      // the user gets the same Mensagem/Ligar/Vídeo/Email row.
      try { router.push(`/u/${encodeURIComponent(email)}`); } catch {}
      return;
    }
    Alert.alert(
      display,
      email,
      [
        { text: t('profile.message') || 'Mensagem', onPress: goChat },
        { text: t('profile.call') || 'Ligar', onPress: goCall },
        { text: t('profile.video') || 'Vídeo', onPress: goVideo },
        { text: t('profile.email') || 'Email', onPress: goEmail },
        { text: t('contacts.editContact') || 'Editar', onPress: goEdit },
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
      ],
      { cancelable: true }
    );
  }, [router, handleEditContact, t]);

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

  const handleDelete = useCallback((email) => {
    const doDelete = async () => { await api.deleteContact(email); loadContacts(); };
    if (Platform.OS === 'web') {
      if (window.confirm(t('contacts.deleteConfirmWeb'))) doDelete();
    } else {
      Alert.alert(t('contacts.deleteTitle'), t('contacts.deleteMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('contacts.delete'), style: 'destructive', onPress: doDelete },
      ]);
    }
  }, [t]);

  const groups = [...new Set(contacts.map(c => c.group).filter(Boolean))];
  const contactEmailSet = useMemo(() => new Set(contacts.map(c => (c.email || '').toLowerCase())), [contacts]);
  const isContactSaved = useCallback((email) => contactEmailSet.has((email || '').toLowerCase()), [contactEmailSet]);

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
      const local = q ? familyUsers.filter(u =>
        (u.display_name || '').toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.phone || '').includes(q)
      ) : familyUsers;

      if (searchResults.length > 0) {
        const localEmails = new Set(local.map(u => u.email));
        const merged = [...local];
        for (const sr of searchResults) {
          if (!localEmails.has(sr.email)) {
            merged.push({ email: sr.email, display_name: sr.name, match_type: sr.match_type });
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

    // Alphabetical buckets.
    const grouped = {};
    for (const c of nonFav) {
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
    return out.concat(alpha);
  }, [filteredItems, activeTab, t]);

  // Render favorite contact (larger avatar). Tap = profile (Instagram/WA
  // pattern) so the favorites row stops being a "shortcut to the edit
  // form" — that's what long-press is for.
  const renderFavoriteContact = (c, i) => (
    <TouchableOpacity
      key={c.id || i}
      style={[s.favoriteItem]}
      onPress={() => handleOpenProfile(c)}
      onLongPress={() => handleQuickActions(c)}
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
    const isRegistered = email ? registeredEmails.has(email.toLowerCase()) : false;
    return (
      <DeviceContactRow
        dc={dc}
        colors={colors}
        saved={saved}
        onAdd={addDeviceContact}
        t={t}
        isRegistered={isRegistered}
        onOpenProfile={handleOpenProfile}
        onQuickActions={handleQuickActions}
      />
    );
  }, [colors, isContactSaved, addDeviceContact, t, registeredEmails, handleOpenProfile, handleQuickActions]);

  // Device contacts split into "On Chatyy" and "Invite to Chatyy" sections
  const deviceSections = useMemo(() => {
    if (activeTab !== 'device' || filteredItems.length === 0 || registeredEmails.size === 0) return [];
    const onChatyy = [];
    const invite = [];
    for (const dc of filteredItems) {
      const email = dc.emails?.[0]?.email || '';
      if (email && registeredEmails.has(email.toLowerCase())) {
        onChatyy.push(dc);
      } else {
        invite.push(dc);
      }
    }
    const sections = [];
    if (onChatyy.length > 0) sections.push({ title: t('contacts.onChatyy') || 'On Chatyy', key: 'on_chatyy', data: onChatyy });
    if (invite.length > 0) sections.push({ title: t('contacts.inviteToChatyy') || 'Invite to Chatyy', key: 'invite', data: invite });
    return sections;
  }, [activeTab, filteredItems, registeredEmails, t]);

  // Render section header for device tab
  const renderDeviceSectionHeader = useCallback(({ section }) => (
    <View style={[s.sectionHeader, { backgroundColor: colors.background }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {section.key === 'on_chatyy' && (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#7C3AED' }} />
        )}
        <Text style={[s.sectionHeaderText, { color: section.key === 'on_chatyy' ? '#16a34a' : colors.textTertiary, fontWeight: '700' }]}>
          {section.title} ({section.data.length})
        </Text>
      </View>
    </View>
  ), [colors]);

  // Share invite link
  const handleShareInvite = useCallback(async () => {
    const msg = t('contacts.inviteMessage') || 'Join me on Chatyy! Download at https://chatyy.com.br';
    if (Platform.OS === 'web') {
      try { await navigator.clipboard.writeText(msg); Alert.alert(t('common.success'), t('contacts.linkCopied') || 'Link copied!'); } catch {}
    } else {
      try {
        const { Share } = require('react-native');
        await Share.share({ message: msg });
      } catch {}
    }
  }, [t]);

  // FlatList render items for family tab
  const renderFamilyItem = useCallback(({ item: user }) => {
    const saved = isContactSaved(user.email);
    return (
      <FamilyUserRow
        user={user}
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
        onOpenProfile={handleOpenProfile}
        onQuickActions={handleQuickActions}
      />
    );
  }, [colors, handleEditContact, handleDelete, toggleFavorite, handleOpenProfile, handleQuickActions]);

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

  const isLoading = (activeTab === 'my' && loading) ||
    (activeTab === 'device' && loadingDevice) ||
    (activeTab === 'family' && loadingFamily);

  // Device/family empty component
  const renderDeviceEmpty = useCallback(() => {
    if (loadingDevice) return null;
    if (devicePermission === 'denied') {
      return (
        <View style={s.emptyContainer}>
          <IconSmartphone size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('contacts.permissionRequired')}</Text>
          <Text style={[s.emptyHint, { color: colors.textTertiary }]}>{t('contacts.permissionMessage')}</Text>
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
              <IconUpload size={18} color="#fff" />
              <Text style={s.bigActionBtnText}>{t('contacts.importVcf')}</Text>
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
    if (loadingFamily) return null;
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

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => { if (Platform.OS === "web" && window.parent !== window) { try { window.parent.postMessage({ type: "close-side-panel", route: "/contacts" }, "*"); } catch {} } else { router.back(); } }} style={s.backBtn}>
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>
          {t('contacts.title')}{contacts.length > 0 ? ` (${contacts.length})` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <TouchableOpacity
            onPress={() => { setForm({ name: '', email: '', phone: '', group: '', notes: '', favorite: false }); setEditContact(null); setShowAdd(true); }}
            style={[s.addBtn, { backgroundColor: colors.primary + '14', borderRadius: 18, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }]}
            activeOpacity={0.7}
            accessibilityLabel={t('contacts.addContact') || 'Add contact'}
            accessibilityRole="button"
          >
            <IconPlus size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

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

      {/* Search */}
      <View style={[s.searchRow, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
        <IconSearch size={16} color={colors.textTertiary} />
        <TextInput
          style={[s.searchInput, { color: colors.text }]}
          value={search}
          onChangeText={setSearch}
          placeholder={activeTab === 'device' ? t('contacts.searchDevice') : activeTab === 'family' ? t('contacts.searchFamily') : t('contacts.searchMy')}
          placeholderTextColor={colors.textTertiary}
        />
      </View>

      {/* Group filter for My Contacts tab */}
      {activeTab === 'my' && groups.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.groupTabs, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]} contentContainerStyle={s.groupTabsContent}>
          <TouchableOpacity
            style={[s.groupTab, activeGroup === 'all' && { backgroundColor: colors.primary }]}
            onPress={() => setActiveGroup('all')}
          >
            <Text style={[s.groupTabText, { color: activeGroup === 'all' ? '#fff' : colors.text }]}>{t('contacts.all')}</Text>
          </TouchableOpacity>
          {groups.map(g => (
            <TouchableOpacity
              key={g}
              style={[s.groupTab, activeGroup === g && { backgroundColor: colors.primary }]}
              onPress={() => setActiveGroup(g)}
            >
              <Text style={[s.groupTabText, { color: activeGroup === g ? '#fff' : colors.text }]}>{g}</Text>
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
            style={[s.actionBtn, { borderColor: colors.primary, backgroundColor: colors.primary + '10' }]}
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
      {loadError && contacts.length === 0 ? (
        <View style={s.emptyContainer}>
          <View style={[s.emptyIconCircle, { backgroundColor: isDark ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.08)' }]}>
            <IconX size={40} color="#ef4444" />
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
              <IconRefresh size={16} color="#fff" />
              <Text style={s.emptyCTAText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : isLoading && contacts.length === 0 && deviceContacts.length === 0 && familyUsers.length === 0 ? (
        <ListSkeleton count={8} />
      ) : activeTab === 'my' ? (
        <SectionList
          sections={alphabeticalSections}
          keyExtractor={myKeyExtractor}
          renderItem={renderMyContactItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled
          ListHeaderComponent={
            <>
              {/* Favorites section */}
              {favoriteContacts.length > 0 && (
                <View style={[s.favoritesSection, { borderBottomColor: colors.borderLight }]}>
                  <Text style={[s.favoritesSectionTitle, { color: colors.text }]}>
                    <IconStar size={14} color="#FBBC05" /> {t('contacts.favorites')}
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
              onAdd={() => setShowAdd(true)}
            />
          }
          contentContainerStyle={s.list}
        />
      ) : activeTab === 'device' ? (
        deviceSections.length > 0 ? (
          <SectionList
            sections={deviceSections}
            keyExtractor={deviceKeyExtractor}
            renderItem={renderDeviceItem}
            renderSectionHeader={renderDeviceSectionHeader}
            stickySectionHeadersEnabled
            ListEmptyComponent={renderDeviceEmpty}
            ListFooterComponent={
              <>
                {renderDeviceFooter()}
                {/* Invite button at bottom */}
                <TouchableOpacity
                  onPress={handleShareInvite}
                  style={[s.inviteBtn, { borderColor: '#7C3AED' }]}
                  activeOpacity={0.7}
                >
                  <IconPlus size={14} color="#7C3AED" />
                  <Text style={[s.inviteBtnText, { color: '#7C3AED' }]}>{t('contacts.shareInviteLink') || 'Share invite link'}</Text>
                </TouchableOpacity>
              </>
            }
            contentContainerStyle={s.list}
            removeClippedSubviews={Platform.OS !== 'web'}
          />
        ) : (
          <FlatList
            data={filteredItems}
            keyExtractor={deviceKeyExtractor}
            renderItem={renderDeviceItem}
            ListEmptyComponent={renderDeviceEmpty}
            ListFooterComponent={renderDeviceFooter}
            contentContainerStyle={s.list}
            removeClippedSubviews={Platform.OS !== 'web'}
          />
        )
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={familyKeyExtractor}
          renderItem={renderFamilyItem}
          ListHeaderComponent={renderFamilyHeader}
          ListEmptyComponent={renderFamilyEmpty}
          contentContainerStyle={s.list}
        />
      )}

      {/* Add/Edit Modal */}
      <Modal visible={showAdd} animationType="slide" transparent>
        <TouchableOpacity style={s.overlay} onPress={() => setShowAdd(false)} activeOpacity={1}>
          <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
            <View style={[s.modalHeader, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.modalTitle, { color: colors.text }]}>
                {editContact ? t('contacts.editContact') : t('contacts.newContact')}
              </Text>
              <TouchableOpacity onPress={() => setShowAdd(false)}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={s.formBody} contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={[s.formFieldLabel, { color: colors.textSecondary }]}>{t('contacts.nameLabel')}</Text>
              <View style={s.formRow}>
                <IconUser size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.name} onChangeText={v => setForm(p => ({ ...p, name: v }))}
                  placeholder={t('contacts.namePlaceholder')} placeholderTextColor={colors.textTertiary}
                  accessibilityLabel={t('contacts.nameLabel')} />
              </View>
              <Text style={[s.formFieldLabel, { color: colors.textSecondary }]}>
                {t('contacts.emailLabel')} <Text style={{ color: colors.error || '#dc2626' }}>*</Text>
              </Text>
              <View style={s.formRow}>
                <IconMail size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: emailError ? (colors.error || '#dc2626') : colors.border }]}
                  value={form.email} onChangeText={v => { setForm(p => ({ ...p, email: v })); if (emailError) setEmailError(''); }}
                  placeholder={t('contacts.emailPlaceholder')} placeholderTextColor={colors.textTertiary}
                  keyboardType="email-address" autoCapitalize="none"
                  accessibilityLabel={t('contacts.emailLabel')} />
              </View>
              {emailError ? (
                <Text style={{ color: colors.error || '#dc2626', fontSize: 12, marginTop: 4, marginLeft: 28 }}>
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
                <IconStar size={18} color={form.favorite ? '#FBBC05' : colors.textTertiary} />
                <Text style={[s.favoriteToggleText, { color: colors.text }]}>{t('contacts.favorites')}</Text>
                <View style={[s.favoriteToggleCheck, form.favorite && { backgroundColor: '#FBBC05' }]}>
                  {form.favorite && <IconCheck size={12} color="#fff" />}
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: colors.primary }, saving && { opacity: 0.6 }]}
                onPress={handleSave} disabled={saving}
              >
                {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.saveBtnText}>{t('contacts.save')}</Text>}
              </TouchableOpacity>
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1,
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
    flexDirection: 'row', borderBottomWidth: 1,
  },
  tab: {
    flex: 1, paddingVertical: Spacing.sm + 4, alignItems: 'center',
    borderBottomWidth: 3, borderBottomColor: 'transparent',
    ...Platform.select({
      web: { transition: 'all 0.2s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '700', letterSpacing: 0.2 },

  // Search
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2, borderBottomWidth: 1, gap: 8,
  },
  searchInput: {
    flex: 1, fontSize: FontSize.base,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },

  // Action bar
  actionBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 4,
    borderBottomWidth: 1, flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: Spacing.md, paddingVertical: 7,
    borderRadius: 12, borderWidth: 1.5,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  actionBtnText: { fontSize: FontSize.xs, fontWeight: '700' },
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
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md + 2, paddingBottom: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  favoritesSectionTitle: {
    fontSize: 10, fontWeight: '800', marginBottom: Spacing.sm,
    textTransform: 'uppercase', letterSpacing: 1.2,
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
    paddingHorizontal: Spacing.md, paddingVertical: 8, paddingTop: 12,
  },
  sectionHeaderText: {
    fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.4,
  },

  // Empty
  emptyContainer: { alignItems: 'center', paddingTop: 48, paddingBottom: 32, paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '500', marginBottom: Spacing.sm, textAlign: 'center' },
  emptyHint: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 18, maxWidth: 280 },
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
      web: { cursor: 'pointer', transition: 'transform 0.15s ease, opacity 0.15s ease', boxShadow: '0 2px 12px rgba(124,58,237,0.25)' },
      default: {},
    }),
  },
  emptyCTAText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  bigActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.xxl,
  },
  bigActionBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Contact row
  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md + 2, paddingHorizontal: Spacing.md,
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
  contactName: { fontSize: FontSize.lg, fontWeight: '700', letterSpacing: -0.25 },
  contactEmail: { fontSize: FontSize.sm, marginTop: 2, opacity: 0.7, fontWeight: '500', letterSpacing: -0.05 },
  contactPhone: { fontSize: FontSize.xs, marginTop: 1, opacity: 0.6 },
  lastContactedText: { fontSize: 10, marginTop: 2 },
  deleteBtn: { padding: Spacing.sm },
  starBtn: { padding: Spacing.sm },

  // Group
  groupChip: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginTop: 3 },
  groupChipText: { fontSize: 10, fontWeight: '600' },
  groupTabs: { borderBottomWidth: 1, maxHeight: 52 },
  groupTabsContent: { paddingHorizontal: Spacing.md, gap: 8, alignItems: 'center', paddingVertical: 10 },
  groupTab: {
    paddingHorizontal: Spacing.md + 2, paddingVertical: 7, borderRadius: 20,
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
    borderRadius: 24, width: '90%', maxWidth: 440, maxHeight: '85%',
    ...Platform.select({
      web: { boxShadow: '0 20px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06)' },
      default: { elevation: 16 },
    }),
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: 1,
  },
  modalTitle: { fontSize: FontSize.xxl, fontWeight: '700', letterSpacing: -0.3 },
  formBody: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg },
  formRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  formSectionLabel: {
    fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
    marginTop: Spacing.sm, marginBottom: Spacing.sm,
  },
  formFieldLabel: {
    fontSize: 12, fontWeight: '600', marginBottom: 4, marginLeft: 28,
  },
  formInput: {
    flex: 1, fontSize: FontSize.lg, borderWidth: 1.5, borderRadius: 14,
    paddingHorizontal: Spacing.md + 2, paddingVertical: Platform.OS === 'web' ? 12 : 10,
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'border-color 0.2s ease' }, default: {} }),
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
    borderRadius: 24, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.md,
    ...Platform.select({
      web: { background: 'linear-gradient(135deg, #7C3AED 0%, #A78BFA 100%)', boxShadow: '0 4px 14px rgba(37,99,235,0.3)', cursor: 'pointer' },
      default: {},
    }),
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700', letterSpacing: 0.2 },
});

export default function ContactsScreen() { return <ErrorBoundary><ContactsScreenInner /></ErrorBoundary>; }
