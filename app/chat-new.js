import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, ActivityIndicator, Alert, Platform, SectionList, Share, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { syncContacts } from '../services/contactSync';
import {
  IconArrowLeft, IconSearch, IconX, IconUsers, IconMessageSquare,
  IconCheck, IconPlus,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s@]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name[0].toUpperCase();
}

function ContactAvatar({ name, size = 40 }) {
  const initials = getInitials(name);
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const bgColor = `hsl(${hue}, 55%, 55%)`;

  return (
    <View style={[styles.contactAvatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor }]}>
      <Text style={[styles.contactAvatarText, { fontSize: size * 0.38 }]}>{initials}</Text>
    </View>
  );
}

export default function ChatNewScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState('direct'); // 'direct' or 'group'
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [chatyContacts, setChatyContacts] = useState([]);
  const [otherContacts, setOtherContacts] = useState([]);
  const [syncingContacts, setSyncingContacts] = useState(false);

  // Sync phone contacts on mount (native only)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let mounted = true;
    setSyncingContacts(true);
    syncContacts().then(result => {
      if (!mounted) return;
      setChatyContacts(result.chatyContacts || []);
      setOtherContacts(result.otherContacts || []);
    }).catch(() => {}).finally(() => {
      if (mounted) setSyncingContacts(false);
    });
    return () => { mounted = false; };
  }, []);

  const handleSearch = useCallback(async (text) => {
    setSearchText(text);
    if (!text || text.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const r = await api.searchContacts(text);
      if (r.success) {
        const contacts = (r.data || []).filter(c => c.email !== user?.email);
        setSearchResults(contacts);
      }
    } catch {} finally {
      setSearching(false);
    }
  }, [user?.email]);

  const handleSelectContact = (contact) => {
    if (mode === 'direct') {
      // Start direct conversation immediately
      handleCreateDirect(contact.email, contact.name || contact.email);
      return;
    }
    // Group mode — toggle selection
    setSelectedMembers(prev => {
      const exists = prev.find(m => m.email === contact.email);
      if (exists) return prev.filter(m => m.email !== contact.email);
      return [...prev, { email: contact.email, name: contact.name || contact.email }];
    });
  };

  const handleCreateDirect = async (targetEmail, targetName) => {
    if (creating) return;
    setCreating(true);
    try {
      const r = await api.chatCreate([targetEmail], '', 'direct');
      const convId = r.data?.conversation_id || r.data?.id;
      const convName = r.data?.name || targetName;
      if (r.success && convId) {
        router.replace(`/chat-conversation?id=${convId}&name=${encodeURIComponent(convName)}&type=direct&email=${encodeURIComponent(targetEmail)}`);
      } else {
        Alert.alert(t('common.error'), r?.message || t('chat.createError'));
      }
    } catch {
      Alert.alert(t('common.error'), t('common.networkError'));
    } finally {
      setCreating(false);
    }
  };

  const handleCreateGroup = async () => {
    if (creating || selectedMembers.length === 0) return;
    if (!groupName.trim() && selectedMembers.length > 1) {
      const names = selectedMembers.slice(0, 3).map(m => (m.name || m.email).split('@')[0]);
      setGroupName(names.join(', '));
    }
    setCreating(true);
    try {
      const members = selectedMembers.map(m => m.email);
      const name = groupName.trim() || t('chat.group');
      const r = await api.chatCreate(members, name, 'group');
      const convId = r.data?.conversation_id || r.data?.id;
      const convName = r.data?.name || name;
      if (r.success && convId) {
        router.replace(`/chat-conversation?id=${convId}&name=${encodeURIComponent(convName)}&type=group`);
      } else {
        Alert.alert(t('common.error'), r?.message || t('chat.createGroupError'));
      }
    } catch {
      Alert.alert(t('common.error'), t('common.networkError'));
    } finally {
      setCreating(false);
    }
  };

  const handleAddEmail = () => {
    const email = searchText.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      Alert.alert(t('chat.invalidEmail'), t('chat.invalidEmailDesc'));
      return;
    }
    if (email === user?.email) return;

    if (mode === 'direct') {
      handleCreateDirect(email, email);
    } else {
      const exists = selectedMembers.find(m => m.email === email);
      if (!exists) {
        setSelectedMembers(prev => [...prev, { email, name: email.split('@')[0] }]);
      }
      setSearchText('');
      setSearchResults([]);
    }
  };

  const isSelected = (email) => selectedMembers.some(m => m.email === email);

  const handleInvite = async (contact) => {
    const inviteMsg = t('chat.inviteMessage') || `Ei ${contact.name}! Baixa o Chatyy pra gente conversar! 📱💬\nhttps://mail.onemundo.com.br`;

    if (Platform.OS === 'web') {
      // On web, just copy to clipboard
      try {
        await navigator.clipboard.writeText(inviteMsg);
        Alert.alert(t('common.success'), t('chat.inviteCopied') || 'Link copiado!');
      } catch {
        Alert.alert('Chatyy', inviteMsg);
      }
      return;
    }

    try {
      await Share.share({
        message: inviteMsg,
        title: 'Chatyy',
      });
    } catch {}
  };

  const renderContact = ({ item }) => {
    const selected = isSelected(item.email);

    // Non-registered contact → show invite button
    if (item.isRegistered === false) {
      return (
        <View style={[styles.contactRow, { borderBottomColor: colors.border }]}>
          <ContactAvatar name={item.name || '?'} size={40} />
          <View style={styles.contactInfo}>
            <Text style={[styles.contactName, { color: colors.text }]} numberOfLines={1}>
              {item.name || item.phone || '?'}
            </Text>
            <Text style={[styles.contactEmail, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.phone || item.email || ''}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.inviteBtn, { borderColor: '#25D366' }]}
            onPress={() => handleInvite(item)}
            activeOpacity={0.7}
          >
            <Text style={styles.inviteBtnText}>{t('chat.invite') || 'Convidar'}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <TouchableOpacity
        style={[styles.contactRow, { borderBottomColor: colors.border }]}
        onPress={() => handleSelectContact(item)}
        activeOpacity={0.7}
      >
        {item.email ? (
          <AvatarCircle email={item.email} name={item.name || item.email} size={40} />
        ) : (
          <ContactAvatar name={item.name || '?'} size={40} />
        )}
        <View style={styles.contactInfo}>
          <Text style={[styles.contactName, { color: colors.text }]} numberOfLines={1}>
            {item.name || item.email?.split('@')[0] || item.phone}
          </Text>
          <Text style={[styles.contactEmail, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.email || item.phone || ''}
          </Text>
          {item.isRegistered && (
            <Text style={[styles.chatyBadge, { color: '#25D366' }]}>Chatyy</Text>
          )}
        </View>
        {mode === 'group' && item.email && (
          <View style={[styles.checkbox, {
            backgroundColor: selected ? colors.primary : 'transparent',
            borderColor: selected ? colors.primary : colors.border,
          }]}>
            {selected && <IconCheck size={14} color="#fff" />}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Build sections for SectionList when not searching
  const buildSections = () => {
    const sections = [];
    if (chatyContacts.length > 0) {
      sections.push({ title: t('chat.contactsOnChatyy') || 'Contacts on Chatyy', data: chatyContacts });
    }
    if (otherContacts.length > 0) {
      sections.push({ title: t('chat.inviteToChatyy') || 'Invite to Chatyy', data: otherContacts.slice(0, 50) });
    }
    return sections;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('chat.newConversation')}</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Mode Toggle */}
      <View style={[styles.toggleRow, { backgroundColor: colors.surfaceVariant || colors.background }]}>
        <TouchableOpacity
          style={[styles.toggleBtn, mode === 'direct' && { backgroundColor: colors.primary }]}
          onPress={() => { setMode('direct'); setSelectedMembers([]); }}
        >
          <IconMessageSquare size={16} color={mode === 'direct' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.toggleText, { color: mode === 'direct' ? '#fff' : colors.textSecondary }]}>
            {t('chat.direct')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, mode === 'group' && { backgroundColor: colors.primary }]}
          onPress={() => setMode('group')}
        >
          <IconUsers size={16} color={mode === 'group' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.toggleText, { color: mode === 'group' ? '#fff' : colors.textSecondary }]}>
            {t('chat.group')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Group Name (group mode only) */}
      {mode === 'group' && (
        <View style={[styles.groupNameWrap, { borderBottomColor: colors.border }]}>
          <TextInput
            style={[styles.groupNameInput, { color: colors.text, borderColor: colors.border }]}
            placeholder={t('chat.groupNamePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={groupName}
            onChangeText={setGroupName}
          />
        </View>
      )}

      {/* Selected Members (group mode) */}
      {mode === 'group' && selectedMembers.length > 0 && (
        <View style={[styles.selectedRow, { borderBottomColor: colors.border }]}>
          <FlatList
            horizontal
            data={selectedMembers}
            keyExtractor={(item) => item.email}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.selectedList}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.selectedChip, { backgroundColor: colors.primary + '15', borderColor: colors.primary + '40' }]}
                onPress={() => setSelectedMembers(prev => prev.filter(m => m.email !== item.email))}
              >
                <Text style={[styles.selectedChipText, { color: colors.primary }]} numberOfLines={1}>
                  {item.name || item.email.split('@')[0]}
                </Text>
                <IconX size={14} color={colors.primary} />
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      {/* Search Input */}
      <View style={[styles.searchWrap, { borderBottomColor: colors.border }]}>
        <IconSearch size={18} color={colors.textTertiary} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={mode === 'direct' ? t('chat.searchOrType') : t('chat.addMembers')}
          placeholderTextColor={colors.textTertiary}
          value={searchText}
          onChangeText={handleSearch}
          onSubmitEditing={handleAddEmail}
          autoFocus
          keyboardType="email-address"
          autoCapitalize="none"
        />
        {searchText ? (
          <TouchableOpacity onPress={() => { setSearchText(''); setSearchResults([]); }}>
            <IconX size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Add email hint */}
      {searchText && searchText.includes('@') && searchResults.length === 0 && !searching && (
        <TouchableOpacity
          style={[styles.addEmailRow, { borderBottomColor: colors.border }]}
          onPress={handleAddEmail}
        >
          <IconPlus size={18} color={colors.primary} />
          <Text style={[styles.addEmailText, { color: colors.primary }]}>
            {mode === 'direct' ? t('chat.startWith', { email: searchText }) : t('chat.addEmail', { email: searchText })}
          </Text>
        </TouchableOpacity>
      )}

      {/* Search Results / Contact Sync List */}
      {searching || syncingContacts ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="small" color={colors.primary} />
          {syncingContacts && <Text style={[styles.syncText, { color: colors.textTertiary }]}>{t('chat.syncingContacts') || 'Syncing contacts...'}</Text>}
        </View>
      ) : searchText.length >= 2 ? (
        <FlatList
          data={searchResults}
          keyExtractor={(item) => item.email}
          renderItem={renderContact}
          contentContainerStyle={styles.contactList}
          ListEmptyComponent={
            !searching ? (
              <View style={styles.emptyResults}>
                <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                  {t('chat.noContactsFound')}
                </Text>
              </View>
            ) : null
          }
        />
      ) : (chatyContacts.length > 0 || otherContacts.length > 0) ? (
        <SectionList
          sections={buildSections()}
          keyExtractor={(item, idx) => item.email || item.phone || String(idx)}
          renderItem={renderContact}
          renderSectionHeader={({ section: { title } }) => (
            <View style={[styles.sectionHeader, { backgroundColor: colors.surfaceVariant || colors.background }]}>
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{title}</Text>
            </View>
          )}
          contentContainerStyle={styles.contactList}
        />
      ) : (
        <View style={styles.emptyResults}>
          <IconSearch size={48} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
            {t('chat.searchContacts')}
          </Text>
        </View>
      )}

      {/* Create Group Button */}
      {mode === 'group' && selectedMembers.length > 0 && (
        <View style={[styles.createBtnWrap, { paddingBottom: insets.bottom + Spacing.md }]}>
          <TouchableOpacity
            style={[styles.createBtn, { backgroundColor: colors.primary }, Shadow.md]}
            onPress={handleCreateGroup}
            disabled={creating}
          >
            {creating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <IconUsers size={18} color="#fff" />
                <Text style={styles.createBtnText}>
                  {t('chat.createGroup', { count: selectedMembers.length })}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700' },
  toggleRow: {
    flexDirection: 'row', marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderRadius: BorderRadius.lg, padding: 3, gap: 4,
  },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md, gap: 6,
  },
  toggleText: { fontSize: FontSize.sm, fontWeight: '600' },
  groupNameWrap: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupNameInput: {
    fontSize: FontSize.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  selectedRow: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  selectedList: { paddingHorizontal: Spacing.md, gap: 6 },
  selectedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: BorderRadius.full || 99, borderWidth: 1,
  },
  selectedChipText: { fontSize: FontSize.sm, fontWeight: '500', maxWidth: 120 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: Spacing.sm,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, padding: 0 },
  addEmailRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addEmailText: { fontSize: FontSize.md, fontWeight: '500' },
  loaderWrap: { paddingVertical: Spacing.xl, alignItems: 'center' },
  contactList: { paddingBottom: 100 },
  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: Spacing.md,
  },
  contactAvatar: { alignItems: 'center', justifyContent: 'center' },
  contactAvatarText: { color: '#fff', fontWeight: '600' },
  contactInfo: { flex: 1 },
  contactName: { fontSize: FontSize.md, fontWeight: '500' },
  contactEmail: { fontSize: FontSize.sm, marginTop: 1 },
  checkbox: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  emptyResults: { alignItems: 'center', paddingTop: 60, paddingHorizontal: Spacing.xl, gap: Spacing.md },
  emptyText: { fontSize: FontSize.sm, textAlign: 'center' },
  chatyBadge: { fontSize: 11, fontWeight: '600', marginTop: 1 },
  inviteBtn: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1.5, borderColor: '#25D366',
  },
  inviteBtnText: { color: '#25D366', fontSize: 13, fontWeight: '600' },
  syncText: { fontSize: FontSize.sm, marginTop: Spacing.sm },
  sectionHeader: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2 },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  createBtnWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: Spacing.md, borderRadius: BorderRadius.lg,
  },
  createBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
});
