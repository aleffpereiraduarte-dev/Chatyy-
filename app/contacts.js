import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView,
  ActivityIndicator, Platform, Modal, Alert, SectionList,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import * as api from '../services/api';
import {
  IconArrowLeft, IconUser, IconMail, IconPhone, IconPlus,
  IconX, IconCheck, IconSearch, IconTrash, IconUsers, IconTag,
  IconDownload, IconUpload, IconRefresh, IconSmartphone,
  IconChevronDown, IconChevronUp, IconStar,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

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

export default function ContactsScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState('my');
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', group: '' });
  const [saving, setSaving] = useState(false);
  const [activeGroup, setActiveGroup] = useState('all');

  // Device contacts
  const [deviceContacts, setDeviceContacts] = useState([]);
  const [loadingDevice, setLoadingDevice] = useState(false);
  const [devicePermission, setDevicePermission] = useState(null);

  // OneMundo family
  const [familyUsers, setFamilyUsers] = useState([]);
  const [loadingFamily, setLoadingFamily] = useState(false);

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  // Server-side search results for OneMundo users
  const [searchResults, setSearchResults] = useState([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const searchTimerRef = useRef(null);

  const TABS = [
    { key: 'my', label: t('contacts.tabMy') },
    { key: 'device', label: t('contacts.tabDevice') },
    { key: 'family', label: t('contacts.tabFamily') },
  ];

  useEffect(() => { loadContacts(); }, []);

  // Debounced server search for family tab
  useEffect(() => {
    if (activeTab !== 'family') return;
    if (search.length < 3) {
      setSearchResults([]);
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      setSearchingUsers(true);
      try {
        const r = await api.searchOneMundoUsers(search);
        if (r.success) setSearchResults(r.data || []);
      } catch {} finally { setSearchingUsers(false); }
    }, 500);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search, activeTab]);

  useEffect(() => {
    if (activeTab === 'device' && deviceContacts.length === 0) loadDeviceContacts();
    if (activeTab === 'family' && familyUsers.length === 0) loadFamilyUsers();
  }, [activeTab]);

  const loadContacts = async () => {
    try {
      const r = await api.getContactsList();
      if (r.success) setContacts(r.data || []);
    } catch {} finally { setLoading(false); }
  };

  // Load device contacts (native only)
  const loadDeviceContacts = async () => {
    if (!Contacts || Platform.OS === 'web') {
      setDevicePermission('web');
      return;
    }
    setLoadingDevice(true);
    try {
      // Check if the native module is actually available
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
      setDeviceContacts(data || []);
    } catch (err) {
      console.warn('Failed to load device contacts:', err);
      setDevicePermission('web');
    } finally { setLoadingDevice(false); }
  };

  // Load OneMundo family users
  const loadFamilyUsers = async () => {
    setLoadingFamily(true);
    try {
      const r = await api.listOneMundoUsers();
      if (r.success) setFamilyUsers(r.data || []);
    } catch {} finally { setLoadingFamily(false); }
  };

  // Add device contact to my contacts
  const addDeviceContact = async (dc) => {
    const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim();
    const email = dc.emails?.[0]?.email || '';
    const phone = dc.phoneNumbers?.[0]?.number || '';
    if (!email && !name) return;
    try {
      await api.saveContact({ name, email, phone, group: '' });
      loadContacts();
      Alert.alert(t('contacts.added'), t('contacts.addedMessage', { name: name || email }));
    } catch {}
  };

  // Add OneMundo user to my contacts
  const addFamilyContact = async (user) => {
    try {
      await api.saveContact({
        name: user.display_name || user.email.split('@')[0],
        email: user.email,
        phone: user.phone || '',
        group: 'OneMundo',
      });
      loadContacts();
      Alert.alert(t('contacts.added'), t('contacts.addedMessage', { name: user.display_name || user.email }));
    } catch {}
  };

  // Sync all device contacts to my contacts
  const syncAllDeviceContacts = async () => {
    if (deviceContacts.length === 0) return;
    const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()));
    const toSync = deviceContacts.filter(dc => {
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

  // vCard import (web)
  const handleImportVCard = () => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.vcf,.vcard';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = parseVCards(text);
      if (parsed.length === 0) { window.alert(t('contacts.noContactsInFile')); return; }
      let imported = 0;
      for (const c of parsed) {
        try { await api.saveContact({ name: c.name, email: c.email, phone: c.phone, group: c.group }); imported++; } catch {}
      }
      if (imported > 0) loadContacts();
      window.alert(t('contacts.contactsImported', { count: imported }));
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

  const handleSave = async () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!form.email.trim() || !emailRegex.test(form.email.trim())) return;
    setSaving(true);
    try {
      const data = { ...form };
      if (editContact?.id) data.id = editContact.id;
      const r = await api.saveContact(data);
      if (r.success) {
        setShowAdd(false); setEditContact(null);
        setForm({ name: '', email: '', phone: '', group: '' });
        loadContacts();
      }
    } catch {} finally { setSaving(false); }
  };

  const handleDelete = (email) => {
    const doDelete = async () => { await api.deleteContact(email); loadContacts(); };
    if (Platform.OS === 'web') {
      if (window.confirm(t('contacts.deleteConfirmWeb'))) doDelete();
    } else {
      Alert.alert(t('contacts.deleteTitle'), t('contacts.deleteMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('contacts.delete'), style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  const groups = [...new Set(contacts.map(c => c.group).filter(Boolean))];

  // Filter logic per tab
  const getFilteredItems = () => {
    const q = search.toLowerCase();

    if (activeTab === 'device') {
      if (!q) return deviceContacts;
      return deviceContacts.filter(dc => {
        const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim();
        const email = dc.emails?.[0]?.email || '';
        const phone = dc.phoneNumbers?.[0]?.number || '';
        return name.toLowerCase().includes(q) || email.toLowerCase().includes(q) || phone.includes(q);
      });
    }

    if (activeTab === 'family') {
      // Merge local family users with server search results
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
  };

  const filteredItems = getFilteredItems();
  const isContactSaved = (email) => contacts.some(c => (c.email || '').toLowerCase() === (email || '').toLowerCase());

  // Render contact row based on tab
  const renderMyContact = (c, i) => (
    <TouchableOpacity
      key={c.id || i}
      style={[s.contactRow, { borderBottomColor: colors.borderLight }]}
      onPress={() => { setForm({ name: c.name || '', email: c.email || '', phone: c.phone || '', group: c.group || '' }); setEditContact(c); setShowAdd(true); }}
      activeOpacity={0.6}
    >
      <AvatarCircle name={c.name || c.email} email={c.email} size={40} style={{ marginRight: Spacing.md }} />
      <View style={s.contactInfo}>
        <Text style={[s.contactName, { color: colors.text }]}>{c.name || c.email}</Text>
        <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{c.email}</Text>
        {!!c.phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{c.phone}</Text>}
        {!!c.group && (
          <View style={[s.groupChip, { backgroundColor: colors.primaryLight }]}>
            <Text style={[s.groupChipText, { color: colors.primary }]}>{c.group}</Text>
          </View>
        )}
      </View>
      <TouchableOpacity onPress={() => handleDelete(c.email)} style={s.deleteBtn}>
        <IconTrash size={16} color={colors.textTertiary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  const renderDeviceContact = (dc, i) => {
    const name = dc.name || `${dc.firstName || ''} ${dc.lastName || ''}`.trim() || t('contacts.unknown');
    const email = dc.emails?.[0]?.email || '';
    const phone = dc.phoneNumbers?.[0]?.number || '';
    const saved = email ? isContactSaved(email) : false;

    return (
      <View key={dc.id || i} style={[s.contactRow, { borderBottomColor: colors.borderLight }]}>
        <View style={[s.avatar, { backgroundColor: getAvatarColor(name) }]}>
          <Text style={s.avatarText}>{name[0].toUpperCase()}</Text>
        </View>
        <View style={s.contactInfo}>
          <Text style={[s.contactName, { color: colors.text }]}>{name}</Text>
          {!!email && <Text style={[s.contactEmail, { color: colors.textSecondary }]}>{email}</Text>}
          {!!phone && <Text style={[s.contactPhone, { color: colors.textTertiary }]}>{phone}</Text>}
          {email && email.toLowerCase().endsWith('@onemundo.com.br') && (
            <View style={[s.groupChip, { backgroundColor: '#dcfce7' }]}>
              <Text style={[s.groupChipText, { color: '#16a34a' }]}>OneMundo</Text>
            </View>
          )}
        </View>
        {saved ? (
          <View style={s.savedBadge}>
            <IconCheck size={14} color={colors.primary} />
          </View>
        ) : (
          <TouchableOpacity onPress={() => addDeviceContact(dc)} style={[s.addContactBtn, { borderColor: colors.primary }]}>
            <IconPlus size={14} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderFamilyUser = (user, i) => {
    const saved = isContactSaved(user.email);
    return (
      <View key={user.email || i} style={[s.contactRow, { borderBottomColor: colors.borderLight }]}>
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
          <TouchableOpacity onPress={() => addFamilyContact(user)} style={[s.addContactBtn, { borderColor: colors.primary }]}>
            <IconPlus size={14} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const isLoading = (activeTab === 'my' && loading) ||
    (activeTab === 'device' && loadingDevice) ||
    (activeTab === 'family' && loadingFamily);

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>
          {t('contacts.title')}{contacts.length > 0 ? ` (${contacts.length})` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <TouchableOpacity onPress={() => { setForm({ name: '', email: '', phone: '', group: '' }); setEditContact(null); setShowAdd(true); }} style={s.addBtn}>
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
              <TouchableOpacity onPress={handleImportVCard} style={[s.actionBtn, { borderColor: colors.border }]}>
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
            {t('contacts.deviceCount', { count: deviceContacts.length })}
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
      {isLoading ? (
        <View style={s.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={s.list}>
          {/* Device permission denied */}
          {activeTab === 'device' && devicePermission === 'denied' && (
            <View style={s.emptyContainer}>
              <IconSmartphone size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
              <Text style={[s.emptyTitle, { color: colors.text }]}>{t('contacts.permissionRequired')}</Text>
              <Text style={[s.emptyHint, { color: colors.textTertiary }]}>
                {t('contacts.permissionMessage')}
              </Text>
            </View>
          )}

          {/* Web device tab - show import options */}
          {activeTab === 'device' && devicePermission === 'web' && (
            <View style={s.emptyContainer}>
              <IconSmartphone size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
              <Text style={[s.emptyTitle, { color: colors.text }]}>{t('contacts.syncWithDevice')}</Text>
              <Text style={[s.emptyHint, { color: colors.textTertiary }]}>
                {t('contacts.syncWebMessage')}
              </Text>
              <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg }}>
                <TouchableOpacity onPress={handleImportVCard} style={[s.bigActionBtn, { backgroundColor: colors.primary }]}>
                  <IconUpload size={18} color="#fff" />
                  <Text style={s.bigActionBtnText}>{t('contacts.importVcf')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Empty state */}
          {filteredItems.length === 0 && !(activeTab === 'device' && (devicePermission === 'denied' || devicePermission === 'web')) && (
            <View style={s.emptyContainer}>
              <IconUsers size={48} color={colors.textTertiary} style={{ opacity: 0.4, marginBottom: Spacing.md }} />
              <Text style={[s.emptyTitle, { color: colors.textTertiary }]}>
                {activeTab === 'my' ? t('contacts.noContacts') : activeTab === 'device' ? t('contacts.noDeviceContacts') : t('contacts.noMembersFound')}
              </Text>
              <Text style={[s.emptyHint, { color: colors.textTertiary }]}>
                {search ? t('contacts.tryDifferentSearch') :
                  activeTab === 'my' ? t('contacts.addOrSync') :
                  activeTab === 'family' ? t('contacts.noOtherAccounts') :
                  t('contacts.allowAccess')}
              </Text>
            </View>
          )}

          {/* Render items based on tab */}
          {activeTab === 'my' && filteredItems.map((c, i) => renderMyContact(c, i))}
          {activeTab === 'device' && devicePermission !== 'denied' && devicePermission !== 'web' && filteredItems.map((dc, i) => renderDeviceContact(dc, i))}
          {activeTab === 'family' && searchingUsers && (
            <View style={{ paddingVertical: Spacing.sm, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          )}
          {activeTab === 'family' && filteredItems.map((u, i) => renderFamilyUser(u, i))}
        </ScrollView>
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
            <View style={s.formBody}>
              <View style={s.formRow}>
                <IconUser size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.name} onChangeText={v => setForm(p => ({ ...p, name: v }))}
                  placeholder={t('contacts.namePlaceholder')} placeholderTextColor={colors.textTertiary} />
              </View>
              <View style={s.formRow}>
                <IconMail size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.email} onChangeText={v => setForm(p => ({ ...p, email: v }))}
                  placeholder={t('contacts.emailPlaceholder')} placeholderTextColor={colors.textTertiary}
                  keyboardType="email-address" autoCapitalize="none" />
              </View>
              <View style={s.formRow}>
                <IconPhone size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.phone} onChangeText={v => setForm(p => ({ ...p, phone: v }))}
                  placeholder={t('contacts.phonePlaceholder')} placeholderTextColor={colors.textTertiary}
                  keyboardType="phone-pad" />
              </View>
              <View style={s.formRow}>
                <IconTag size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput style={[s.formInput, { color: colors.text, borderColor: colors.border }]}
                  value={form.group} onChangeText={v => setForm(p => ({ ...p, group: v }))}
                  placeholder={t('contacts.groupPlaceholder')}
                  placeholderTextColor={colors.textTertiary} />
              </View>
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: colors.primary }, saving && { opacity: 0.6 }]}
                onPress={handleSave} disabled={saving}
              >
                {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.saveBtnText}>{t('contacts.save')}</Text>}
              </TouchableOpacity>
            </View>
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
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.sm },
  headerTitle: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  addBtn: { padding: Spacing.sm },

  // Tabs
  tabBar: {
    flexDirection: 'row', borderBottomWidth: 1,
  },
  tab: {
    flex: 1, paddingVertical: Spacing.sm + 2, alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Search
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 1, gap: 8,
  },
  searchInput: {
    flex: 1, fontSize: FontSize.base,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },

  // Action bar
  actionBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderBottomWidth: 1, flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 5,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  actionBtnText: { fontSize: FontSize.xs, fontWeight: '600' },
  actionHint: { fontSize: FontSize.xs, marginLeft: 'auto' },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: Spacing.md, paddingBottom: 40 },

  // Empty
  emptyContainer: { alignItems: 'center', paddingTop: 48, paddingBottom: 32, paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '500', marginBottom: Spacing.sm, textAlign: 'center' },
  emptyHint: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 18 },
  bigActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.xxl,
  },
  bigActionBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Contact row
  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  contactInfo: { flex: 1 },
  contactName: { fontSize: FontSize.lg, fontWeight: '500' },
  contactEmail: { fontSize: FontSize.sm, marginTop: 2 },
  contactPhone: { fontSize: FontSize.xs, marginTop: 1 },
  deleteBtn: { padding: Spacing.sm },

  // Group
  groupChip: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginTop: 3 },
  groupChipText: { fontSize: 10, fontWeight: '600' },
  groupTabs: { borderBottomWidth: 1, maxHeight: 48 },
  groupTabsContent: { paddingHorizontal: Spacing.md, gap: 6, alignItems: 'center', paddingVertical: 8 },
  groupTab: { paddingHorizontal: Spacing.md, paddingVertical: 6, borderRadius: BorderRadius.xxl },
  groupTabText: { fontSize: FontSize.sm, fontWeight: '500' },

  // Family badge
  familyBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  familyBadgeText: { fontSize: 10, fontWeight: '700' },

  // Add contact button (device/family rows)
  addContactBtn: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  savedBadge: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center', opacity: 0.5,
  },

  // Modal
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 420 },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: 1,
  },
  modalTitle: { fontSize: FontSize.xxl, fontWeight: '600' },
  formBody: { padding: Spacing.xl },
  formRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  formInput: {
    flex: 1, fontSize: FontSize.lg, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Platform.OS === 'web' ? 10 : 8,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  saveBtn: {
    borderRadius: BorderRadius.xxl, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.md,
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
});
