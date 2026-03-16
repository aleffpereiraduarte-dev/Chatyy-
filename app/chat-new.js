import React, { useState, useCallback, useEffect, useRef } from 'react';
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
  IconCheck, IconPlus, IconMail,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

export default function ChatNewScreen() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

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
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  // Contact lists (phone contacts only - WhatsApp style)
  const [phoneContacts, setPhoneContacts] = useState([]);
  const [otherContacts, setOtherContacts] = useState([]);
  const [syncingContacts, setSyncingContacts] = useState(false);

  // Invite states
  const [invitingEmail, setInvitingEmail] = useState(null);
  const [showInviteInput, setShowInviteInput] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  const searchTimeout = useRef(null);

  // On web: don't auto-load all users (privacy, like WhatsApp)
  // On native: phone contacts sync only after user taps button (Apple requires user education)
  const [contactSyncConsented, setContactSyncConsented] = useState(Platform.OS === 'web');

  const doContactSync = useCallback(() => {
    if (Platform.OS === 'web') return;
    setSyncingContacts(true);
    syncContacts().then(result => {
      setPhoneContacts(result.chatyContacts || []);
      setOtherContacts(result.otherContacts || []);
    }).catch(() => {}).finally(() => setSyncingContacts(false));
  }, []);

  // Only sync contacts after user has consented
  useEffect(() => {
    if (!contactSyncConsented || Platform.OS === 'web') return;
    doContactSync();
  }, [contactSyncConsented]);

  const handleSearch = useCallback((text) => {
    setSearchText(text);
    clearTimeout(searchTimeout.current);
    if (!text || text.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        // Search both Chatyy directory and email contacts in parallel
        const [chatyyR, contactsR] = await Promise.all([
          api.chatyyUsers(text, 50),
          api.searchContacts(text),
        ]);

        const merged = new Map();

        // Chatyy users first (priority)
        if (chatyyR.success) {
          for (const u of (chatyyR.data?.users || [])) {
            if (u.email !== user?.email) {
              merged.set(u.email, { ...u, isRegistered: true });
            }
          }
        }

        // Then email contacts
        if (contactsR.success) {
          for (const c of (contactsR.data || [])) {
            if (c.email !== user?.email && !merged.has(c.email)) {
              merged.set(c.email, { ...c, isRegistered: false });
            }
          }
        }

        setSearchResults(Array.from(merged.values()));
      } catch {}
      setSearching(false);
    }, 300);
  }, [user?.email]);

  const handleSelectContact = (contact) => {
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
    setCreating(true);
    try {
      const r = await api.chatCreate([targetEmail], '', 'direct');
      const convId = r.data?.conversation_id || r.data?.id;
      const convName = r.data?.name || targetName;
      if (r.success && convId) {
        router.replace(`/chat-conversation?id=${convId}&name=${encodeURIComponent(convName)}&type=direct&email=${encodeURIComponent(targetEmail)}`);
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
    const inviteMsg = t('chat.inviteMessage') || `${name ? name + ', ' : ''}junte-se a mim no Chatyy! Mensagens seguras e gratuitas 💬\n\nhttps://chatyy.com.br`;
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(inviteMsg);
        safeAlert('✅', t('chat.inviteCopied') || 'Link copiado!');
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
        safeAlert('✅', t('chat.inviteSent') || `Convite enviado para ${email}!`);
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
    const msg = encodeURIComponent(t('chat.inviteMessage') || 'Junte-se a mim no Chatyy! 💬 https://chatyy.com.br');
    const url = phone
      ? `https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`
      : `https://wa.me/?text=${msg}`;
    Linking.openURL(url).catch(() => {});
  };

  const handleInviteViaSMS = (contact) => {
    const phone = contact.phone || '';
    if (!phone) return;
    const msg = encodeURIComponent(t('chat.inviteMessage') || 'Junte-se a mim no Chatyy! 💬 https://chatyy.com.br');
    Linking.openURL(`sms:${phone}?body=${msg}`).catch(() => {});
  };

  const isSelected = (email) => selectedMembers.some(m => m.email === email);

  // ---- Render contact row ----
  const renderContact = ({ item }) => {
    const selected = isSelected(item.email);
    const isChatyyUser = item.isRegistered === true;

    // Non-registered contact → show invite options
    if (!isChatyyUser) {
      return (
        <View style={[s.contactRow, { borderBottomColor: colors.border }]}>
          <AvatarCircle email={item.email || ''} name={item.name || item.phone || '?'} size={48} colors={colors} />
          <View style={s.contactInfo}>
            <Text style={[s.contactName, { color: colors.text }]} numberOfLines={1}>
              {item.name || item.phone || '?'}
            </Text>
            <Text style={[s.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
              {item.email || item.phone || ''}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {/* Send invite email */}
            {item.email && (
              <TouchableOpacity
                style={[s.inviteBtn, { backgroundColor: '#25D366' }]}
                onPress={() => handleInviteByEmail(item.email, item.name)}
                disabled={invitingEmail === item.email}
                activeOpacity={0.7}
              >
                {invitingEmail === item.email ? (
                  <ActivityIndicator size={14} color="#fff" />
                ) : (
                  <Text style={s.inviteBtnText}>
                    {Platform.OS === 'web' ? '✉️' : ''} {t('chat.invite') || 'Convidar'}
                  </Text>
                )}
              </TouchableOpacity>
            )}
            {/* WhatsApp invite */}
            {item.phone && Platform.OS !== 'web' && (
              <TouchableOpacity
                style={[s.inviteIconBtn, { backgroundColor: '#25D366' }]}
                onPress={() => handleInviteViaWhatsApp(item)}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 16 }}>💬</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      );
    }

    // Registered Chatyy user
    return (
      <TouchableOpacity
        style={[s.contactRow, { borderBottomColor: colors.border }]}
        onPress={() => handleSelectContact(item)}
        activeOpacity={0.7}
      >
        <AvatarCircle email={item.email} name={item.name || item.email} size={48} colors={colors} />
        <View style={s.contactInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[s.contactName, { color: colors.text }]} numberOfLines={1}>
              {item.name || item.email?.split('@')[0]}
            </Text>
            <View style={[s.chatyyBadge, { backgroundColor: '#25D366' }]}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3 }}>CHATYY</Text>
            </View>
          </View>
          <Text style={[s.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
            {item.email}
          </Text>
          {item.about ? (
            <Text style={[s.contactAbout, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.about}
            </Text>
          ) : null}
        </View>
        {(mode === 'group' || mode === 'channel') && item.email && (
          <View style={[s.checkbox, {
            backgroundColor: selected ? colors.primary : 'transparent',
            borderColor: selected ? colors.primary : colors.border,
          }]}>
            {selected && <IconCheck size={14} color="#fff" />}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Build sections - WhatsApp style: only show contacts saved in phone
  const buildSections = () => {
    const sections = [];

    // Phone contacts that are on Chatyy (like WhatsApp - only people in your address book)
    if (phoneContacts.length > 0) {
      sections.push({
        title: `${t('chat.contactsOnChatyy') || 'Contatos no Chatyy'} (${phoneContacts.length})`,
        data: phoneContacts,
      });
    }

    // Non-registered phone contacts (invite them)
    if (otherContacts.length > 0) {
      sections.push({
        title: `${t('chat.inviteToChatyy') || 'Convidar para o Chatyy'} (${otherContacts.length})`,
        data: otherContacts.slice(0, 50),
      });
    }

    return sections;
  };

  const sections = buildSections();

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
        <TouchableOpacity onPress={() => router.back()} style={[s.headerBtn, { backgroundColor: isDark ? '#ffffff12' : '#00000008', borderRadius: 20 }]}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('chat.newConversation')}</Text>
        <View style={s.headerBtn} />
      </View>

      {/* Mode Toggle */}
      <View style={[s.toggleRow, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
        <TouchableOpacity
          style={[s.toggleBtn, mode === 'direct' && [s.toggleBtnActive, { backgroundColor: '#25D366' }]]}
          onPress={() => { setMode('direct'); setSelectedMembers([]); }}
        >
          <IconMessageSquare size={15} color={mode === 'direct' ? '#fff' : colors.textSecondary} />
          <Text style={[s.toggleText, { color: mode === 'direct' ? '#fff' : colors.textSecondary }]}>
            {t('chat.direct')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.toggleBtn, mode === 'group' && [s.toggleBtnActive, { backgroundColor: '#25D366' }]]}
          onPress={() => setMode('group')}
        >
          <IconUsers size={15} color={mode === 'group' ? '#fff' : colors.textSecondary} />
          <Text style={[s.toggleText, { color: mode === 'group' ? '#fff' : colors.textSecondary }]}>
            {t('chat.group')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.toggleBtn, mode === 'channel' && [s.toggleBtnActive, { backgroundColor: '#25D366' }]]}
          onPress={() => setMode('channel')}
        >
          <Text style={{ fontSize: 13, marginRight: 3 }}>📢</Text>
          <Text style={[s.toggleText, { color: mode === 'channel' ? '#fff' : colors.textSecondary }]}>
            {t('chat.channels') || 'Canal'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Group/Channel Name */}
      {(mode === 'group' || mode === 'channel') && (
        <View style={[s.groupNameWrap, { borderBottomColor: colors.border }]}>
          <TextInput
            style={[s.groupNameInput, { color: colors.text, borderColor: isDark ? '#333' : '#e0e0e0', backgroundColor: isDark ? '#1e1e1e' : '#f5f5f7' }]}
            placeholder={mode === 'channel' ? (t('chat.channelName') || 'Nome do canal') : t('chat.groupNamePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={groupName}
            onChangeText={setGroupName}
          />
        </View>
      )}

      {/* Selected Members */}
      {(mode === 'group' || mode === 'channel') && selectedMembers.length > 0 && (
        <View style={[s.selectedRow, { borderBottomColor: colors.border }]}>
          <FlatList
            horizontal
            data={selectedMembers}
            keyExtractor={(item) => item.email}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.selectedList}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[s.selectedChip, { backgroundColor: colors.primary + '15', borderColor: colors.primary + '40' }]}
                onPress={() => setSelectedMembers(prev => prev.filter(m => m.email !== item.email))}
              >
                <Text style={[s.selectedChipText, { color: colors.primary }]} numberOfLines={1}>
                  {item.name || item.email.split('@')[0]}
                </Text>
                <IconX size={14} color={colors.primary} />
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      {/* Search Input */}
      <View style={[s.searchWrap, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
        <IconSearch size={18} color={colors.textTertiary} />
        <TextInput
          style={[s.searchInput, { color: colors.text }]}
          placeholder={t('chat.searchOrType') || 'Buscar nome ou email...'}
          placeholderTextColor={colors.textTertiary}
          value={searchText}
          onChangeText={handleSearch}
          onSubmitEditing={handleAddEmail}
          autoFocus
          keyboardType="email-address"
          autoCapitalize="none"
        />
        {searchText ? (
          <TouchableOpacity onPress={() => { setSearchText(''); setSearchResults([]); }} style={{ padding: 4 }}>
            <IconX size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Invite by email banner */}
      {!searchText && (
        <TouchableOpacity
          style={[s.inviteBanner, { backgroundColor: isDark ? '#1a2e1a' : '#f0faf3' }]}
          onPress={() => setShowInviteInput(!showInviteInput)}
          activeOpacity={0.7}
        >
          <View style={[s.inviteBannerIcon, { backgroundColor: '#25D366' }]}>
            <IconMail size={18} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
              {t('chat.inviteFriend') || 'Convidar amigo por email'}
            </Text>
            <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 3 }}>
              {t('chat.inviteFriendDesc') || 'Envie um convite para usar o Chatyy'}
            </Text>
          </View>
          <Text style={{ fontSize: 18 }}>✉️</Text>
        </TouchableOpacity>
      )}

      {/* Inline invite input */}
      {showInviteInput && !searchText && (
        <View style={[s.inviteInputWrap, { backgroundColor: colors.surface }]}>
          <TextInput
            style={[s.inviteInput, { color: colors.text, backgroundColor: isDark ? '#1e1e1e' : '#f5f5f7', borderColor: isDark ? '#333' : '#e0e0e0' }]}
            placeholder="email@exemplo.com"
            placeholderTextColor={colors.textTertiary}
            value={inviteEmail}
            onChangeText={setInviteEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <TouchableOpacity
            style={[s.inviteSendBtn, { backgroundColor: inviteEmail.includes('@') ? '#25D366' : colors.border }]}
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
                {t('chat.sendInvite') || 'Enviar'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Share link button */}
      {!searchText && (
        <TouchableOpacity
          style={[s.inviteBanner, { backgroundColor: isDark ? '#1a1a2e' : '#f0f0fa' }]}
          onPress={() => handleInviteShare({})}
          activeOpacity={0.7}
        >
          <View style={[s.inviteBannerIcon, { backgroundColor: '#6366f1' }]}>
            <Text style={{ fontSize: 16 }}>🔗</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
              {t('chat.shareLink') || 'Compartilhar link'}
            </Text>
            <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 3 }}>
              {t('chat.shareLinkDesc') || 'Copiar link de convite do Chatyy'}
            </Text>
          </View>
          <Text style={{ fontSize: 18 }}>📋</Text>
        </TouchableOpacity>
      )}

      {/* Add email hint — only for group mode (direct requires registered user) */}
      {searchText && searchText.includes('@') && searchResults.length === 0 && !searching && mode !== 'direct' && (
        <TouchableOpacity
          style={[s.addEmailRow, { borderBottomColor: colors.border }]}
          onPress={handleAddEmail}
        >
          <IconPlus size={18} color={colors.primary} />
          <Text style={[s.addEmailText, { color: colors.primary }]}>
            {t('chat.addEmail', { email: searchText })}
          </Text>
        </TouchableOpacity>
      )}

      {/* Content */}
      {searching || syncingContacts ? (
        <View style={s.loaderWrap}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ color: colors.textTertiary, fontSize: 13, marginTop: 8 }}>
            {syncingContacts ? (t('chat.syncingContacts') || 'Sincronizando contatos...') : (t('common.loading') || 'Carregando...')}
          </Text>
        </View>
      ) : searchText.length >= 2 ? (
        <FlatList
          data={searchResults}
          keyExtractor={(item, i) => item.email || String(i)}
          renderItem={renderContact}
          contentContainerStyle={s.contactList}
          ListEmptyComponent={
            <View style={s.emptyResults}>
              <View style={[s.emptyIconCircle, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
                <Text style={{ fontSize: 32 }}>🔍</Text>
              </View>
              <Text style={[s.emptyTitle, { color: colors.text }]}>
                {t('chat.noContactsFound') || 'Nenhum contato encontrado'}
              </Text>
              <Text style={[s.emptyText, { color: colors.textTertiary }]}>
                {t('chat.tryDifferentSearch') || 'Tente buscar com outro nome ou email'}
              </Text>
              {searchText.includes('@') && (
                <TouchableOpacity
                  style={[s.emptyInviteBtn]}
                  onPress={() => handleInviteByEmail(searchText.trim())}
                >
                  <Text style={[s.inviteBtnText, { fontSize: 14 }]}>
                    {t('chat.inviteEmail') || `Convidar ${searchText}`}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          }
        />
      ) : sections.length > 0 ? (
        <SectionList
          sections={sections}
          keyExtractor={(item, idx) => item.email || item.phone || String(idx)}
          renderItem={renderContact}
          renderSectionHeader={({ section: { title } }) => (
            <View style={[s.sectionHeader, { backgroundColor: isDark ? '#111' : '#f8f8fa' }]}>
              <View style={s.sectionAccentLine} />
              <Text style={[s.sectionTitle, { color: colors.textSecondary }]}>{title}</Text>
            </View>
          )}
          contentContainerStyle={s.contactList}
          stickySectionHeadersEnabled
        />
      ) : !contactSyncConsented && Platform.OS !== 'web' ? (
        <View style={s.emptyResults}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>📇</Text>
          <Text style={[s.emptyText, { color: colors.text, fontWeight: '600', fontSize: 16, marginBottom: 8 }]}>
            {t('chat.findContactsTitle') || 'Find your contacts on Chatyy'}
          </Text>
          <Text style={[s.emptyText, { color: colors.textTertiary, marginBottom: 20, paddingHorizontal: 20, lineHeight: 20 }]}>
            {t('chat.findContactsDesc') || 'Chatyy will check your phone contacts to find people you know who are already using the app. Your contacts are not stored on our servers.'}
          </Text>
          <TouchableOpacity
            style={[s.createBtn, { backgroundColor: '#25D366', paddingHorizontal: 32 }]}
            onPress={() => setContactSyncConsented(true)}
            accessibilityLabel="Find contacts on Chatyy"
            accessibilityRole="button"
          >
            <IconUsers size={18} color="#fff" />
            <Text style={s.createBtnText}>{t('chat.findContactsBtn') || 'Find contacts on Chatyy'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={s.emptyResults}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>👋</Text>
          <Text style={[s.emptyText, { color: colors.text, fontWeight: '600', fontSize: 16 }]}>
            {t('chat.noContactsYet') || 'Nenhum contato ainda'}
          </Text>
          <Text style={[s.emptyText, { color: colors.textTertiary, marginTop: 4 }]}>
            {t('chat.inviteFriendsHint') || 'Convide seus amigos para o Chatyy!'}
          </Text>
        </View>
      )}

      {/* Create Group Button */}
      {mode === 'group' && selectedMembers.length > 0 && (
        <View style={[s.createBtnWrap, { paddingBottom: insets.bottom + Spacing.md }]}>
          <TouchableOpacity
            style={[s.createBtn, { backgroundColor: colors.primary }, Shadow.md]}
            onPress={handleCreateGroup}
            disabled={creating}
          >
            {creating ? <ActivityIndicator size="small" color="#fff" /> : (
              <>
                <IconUsers size={18} color="#fff" />
                <Text style={s.createBtnText}>{t('chat.createGroup', { count: selectedMembers.length })}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Create Channel Button */}
      {mode === 'channel' && groupName.trim() && (
        <View style={[s.createBtnWrap, { paddingBottom: insets.bottom + Spacing.md }]}>
          <TouchableOpacity
            style={[s.createBtn, { backgroundColor: colors.primary }, Shadow.md]}
            onPress={handleCreateChannel}
            disabled={creating}
          >
            {creating ? <ActivityIndicator size="small" color="#fff" /> : (
              <>
                <Text style={{ fontSize: 16, marginRight: 6 }}>📢</Text>
                <Text style={s.createBtnText}>{t('chat.createChannel') || 'Criar canal'}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
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
      web: { boxShadow: '0 2px 8px rgba(37,211,102,0.25)' },
      default: {},
    }),
    elevation: 3,
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
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
  selectedRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  selectedList: { paddingHorizontal: Spacing.md, gap: 8 },
  selectedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1,
    ...Platform.select({
      web: { boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
      default: {},
    }),
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
  },
  selectedChipText: { fontSize: 13, fontWeight: '500', maxWidth: 120 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.md, marginVertical: 10,
    paddingHorizontal: 14, height: 44,
    borderRadius: 16, gap: 10,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  addEmailRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addEmailText: { fontSize: FontSize.md, fontWeight: '500' },
  inviteBanner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.md, marginTop: 8,
    paddingHorizontal: 16, paddingVertical: 16,
    borderRadius: 16, gap: 14,
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
  inviteBannerIcon: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
  },
  inviteInputWrap: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.md, marginTop: 6,
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
  loaderWrap: { paddingVertical: 40, alignItems: 'center' },
  contactList: { paddingBottom: 100 },
  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 14,
  },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 16, fontWeight: '500' },
  contactSub: { fontSize: 12, marginTop: 2, opacity: 0.7 },
  contactAbout: { fontSize: 12, marginTop: 3, fontStyle: 'italic' },
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
    backgroundColor: '#25D366',
    ...Platform.select({
      web: { boxShadow: '0 1px 3px rgba(37,211,102,0.3)' },
      default: {},
    }),
    elevation: 2,
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
  inviteBtnText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },
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
  emptyInviteBtn: {
    backgroundColor: '#25D366', paddingHorizontal: 24, height: 40,
    borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginTop: 16,
    ...Platform.select({
      web: { boxShadow: '0 2px 8px rgba(37,211,102,0.3)' },
      default: {},
    }),
    elevation: 3,
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 10, gap: 8,
  },
  sectionAccentLine: {
    width: 3, height: 14, borderRadius: 2, backgroundColor: '#25D366',
  },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  createBtnWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, height: 50, borderRadius: 25,
    backgroundColor: '#25D366',
    ...Platform.select({
      web: { boxShadow: '0 3px 12px rgba(37,211,102,0.3)' },
      default: {},
    }),
    elevation: 4,
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  createBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
});
