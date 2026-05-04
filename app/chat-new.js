import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, Image,
  FlatList, ActivityIndicator, Alert, Platform, SectionList, Share, Linking,
  ScrollView, Modal, ActionSheetIOS,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { syncContacts } from '../services/contactSync';
import { prettifyHandle } from '../services/displayName';
import {
  IconArrowLeft, IconSearch, IconX, IconUsers, IconMessageSquare,
  IconCheck, IconPlus, IconMail, IconRefresh, IconClock, IconUserPlus,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// QR code icon (inline SVG component)
function IconQrCode({ size = 24, color = '#000' }) {
  // Simple grid-based QR icon
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: size * 0.75, color, lineHeight: size }}>⊞</Text>
    </View>
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

  // Contact lists
  const [phoneContacts, setPhoneContacts] = useState([]);
  const [otherContacts, setOtherContacts] = useState([]);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [directoryUsers, setDirectoryUsers] = useState([]); // All Chatyy users
  const [recentContacts, setRecentContacts] = useState([]); // Recent chats
  const [suggestions, setSuggestions] = useState([]); // "Pessoas que você pode conhecer"
  const [loadingRecents, setLoadingRecents] = useState(true);
  const [loadingDirectory, setLoadingDirectory] = useState(true);

  // Invite states
  const [invitingEmail, setInvitingEmail] = useState(null);
  const [showInviteInput, setShowInviteInput] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  // QR modal
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrMode, setQrMode] = useState('show'); // 'show' or 'scan'
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [qrScanned, setQrScanned] = useState(false);

  const searchTimeout = useRef(null);
  const sectionListRef = useRef(null);
  const hasSyncedRef = useRef(false);

  // Auto-sync contacts on first open (native only). syncContacts now shows
  // the consent disclosure modal (Apple guideline 5.1.2) before any data
  // leaves the device, so this auto-trigger is safe even on first launch.
  useEffect(() => {
    if (Platform.OS === 'web' || hasSyncedRef.current) return;
    hasSyncedRef.current = true;
    setSyncingContacts(true);
    syncContacts(false, t).then(result => {
      setPhoneContacts(result.chatyContacts || []);
      setOtherContacts(result.otherContacts || []);
    }).catch(() => {}).finally(() => setSyncingContacts(false));
  }, [t]);

  // Manual refresh
  const doContactSync = useCallback(() => {
    if (Platform.OS === 'web') return;
    setSyncingContacts(true);
    syncContacts(true, t).then(result => {
      setPhoneContacts(result.chatyContacts || []);
      setOtherContacts(result.otherContacts || []);
      if (result.error === 'permission_denied') {
        Alert.alert(
          t('chat.contactPermissionDeniedTitle') || 'Permissão negada',
          t('chat.contactPermissionDeniedMsg') || 'Pra encontrar seus amigos no Chatyy, abra Ajustes do iPhone → Chatyy → Contatos e habilite o acesso.',
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            { text: t('chat.openSettings') || 'Abrir Ajustes', onPress: () => { try { require('react-native').Linking.openURL('app-settings:'); } catch {} } },
          ]
        );
      } else if (result.error) {
        Alert.alert('Erro', String(result.error));
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
        const users = (r.data?.users || []).filter(u => u.email !== user?.email);
        setDirectoryUsers(users.map(u => ({ ...u, isRegistered: true })));
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
  const buildSections = useCallback(() => {
    const sections = [];
    // Suggestions section — curated top-N by the backend (friends-of-friends,
    // group co-members, phone contacts). On web the main directory list is
    // alphabetical across all registered users, so a person may appear in
    // both sections — that's fine (Facebook/LinkedIn work the same way).
    if (suggestions.length > 0) {
      sections.push({
        key: 'suggestions',
        title: t('chat.peopleYouMayKnow') || 'Pessoas que você pode conhecer',
        data: suggestions,
      });
    }
    // WhatsApp parity: "Contacts on Chatyy" = contacts from MY phone book
    // who are registered, not the global directory. This is what users
    // expect when scanning the section header.
    if (phoneContacts.length > 0) {
      sections.push({
        key: 'phone_chatyy',
        title: `${t('chat.contactsOnChatyy')} (${phoneContacts.length})`,
        data: phoneContacts,
      });
    }
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
  }, [allChatyyUsers, otherContacts, suggestions, t]);

  const sections = buildSections();

  const handleSearch = useCallback((text) => {
    setSearchText(text);
    clearTimeout(searchTimeout.current);
    if (!text || text.length < 1) {
      setSearchResults([]);
      return;
    }

    // Instant local filtering from already-loaded users (no API call needed)
    const q = text.toLowerCase().trim();
    // Normalize: treat dots, hyphens, underscores as spaces for matching
    const qNorm = q.replace(/[.\-_]/g, ' ');
    const qParts = qNorm.split(/\s+/).filter(Boolean);

    // Strip leading @ for username search
    const isUsernameSearch = q.startsWith('@');
    const qClean = isUsernameSearch ? q.slice(1) : q;

    const localResults = allChatyyUsers.filter(u => {
      const name = (u.name || '').toLowerCase();
      const email = (u.email || '').toLowerCase();
      const emailUser = email.split('@')[0];
      const handle = (u.username || '').toLowerCase();
      // Normalize name and username for fuzzy matching
      const nameNorm = name.replace(/[.\-_]/g, ' ');
      const userNorm = emailUser.replace(/[.\-_]/g, ' ');
      const phone = (u.phone || '').replace(/\D/g, '');
      const qDigits = qClean.replace(/\D/g, '');

      // @username search: match against the handle field or email username
      if (isUsernameSearch && qClean) {
        if (handle.includes(qClean) || emailUser.includes(qClean)) return true;
        return false;
      }

      // Direct match (original query)
      if (name.includes(q) || email.includes(q) || emailUser.includes(q) || handle.includes(q)) return true;
      // Normalized match (dots/spaces/hyphens equivalent)
      if (nameNorm.includes(qNorm) || userNorm.includes(qNorm)) return true;
      // Multi-word match: all query parts must appear somewhere
      if (qParts.length > 1) {
        const searchable = `${nameNorm} ${userNorm} ${email} ${handle}`;
        if (qParts.every(p => searchable.includes(p))) return true;
      }
      // Phone match
      if (qDigits.length >= 3 && phone.includes(qDigits)) return true;
      return false;
    });
    if (localResults.length > 0) {
      setSearchResults(localResults);
      setSearching(false);
    } else {
      setSearchResults([]);
      setSearching(true);
    }

    // ALWAYS also search server (local cache may be empty or incomplete)
    // If the query looks like a phone number (≥ 8 digits, mostly digits),
    // hash it and hit chat_sync_contacts — that's how we find Chatyy users by
    // phone without ever sending the plaintext number to the server.
    const digitsOnly = qClean.replace(/\D/g, '');
    const looksLikePhone = digitsOnly.length >= 8 && digitsOnly.length === qClean.replace(/[\s+()\-.]/g, '').length;

    searchTimeout.current = setTimeout(async () => {
      try {
        // Build parallel API calls; include @username search if query starts with @
        const promises = [
          api.chatyyUsers(text, 50),
          api.searchContacts(text),
        ];
        if (isUsernameSearch && qClean.length >= 2) {
          promises.push(api.searchByUsername(qClean));
        }

        // Phone lookup: when the user EXPLICITLY types a number into the
        // search bar, bypass the contacts-consent gate (which only governs
        // bulk uploads of the phonebook) and call find_by_phone directly.
        // Why: syncContactsHashed silently returns [] when contacts consent
        // isn't granted — and on web, where there is no contacts disclosure
        // flow at all, that meant phone search appeared totally broken.
        let phonePromise = null;
        if (looksLikePhone) {
          const candidate = qClean.startsWith('+') ? qClean : ('+' + digitsOnly);
          phonePromise = api.findByPhone(candidate).then(r => {
            const list = (r?.success && Array.isArray(r?.data)) ? r.data : [];
            return { matches: list.map(x => ({ email: x.email, name: x.display_name || x.name || (x.email || '').split('@')[0] })) };
          }).catch(() => ({ matches: [] }));
        }

        const results = await Promise.all(promises);
        const [chatyyR, contactsR] = results;
        const usernameR = results[2] || null;

        const merged = new Map();
        // Keep local results first
        for (const r of localResults) {
          if (r.email) merged.set(r.email, r);
        }

        // Phone match wins top spot — user typed the exact number, so the hit
        // is almost certainly the person they want to reach.
        if (phonePromise) {
          try {
            const pRes = await phonePromise;
            for (const m of (pRes?.matches || [])) {
              if (m.email && m.email !== user?.email && !merged.has(m.email)) {
                merged.set(m.email, {
                  email: m.email,
                  name: m.name,
                  isRegistered: true,
                  _matchedByPhone: true,
                });
              }
            }
          } catch {}
        }

        // @username search results (highest priority for username queries)
        if (usernameR?.success) {
          for (const u of (usernameR.data?.users || [])) {
            if (u.email !== user?.email && !merged.has(u.email)) {
              merged.set(u.email, { ...u, isRegistered: true });
            }
          }
        }

        if (chatyyR?.success) {
          for (const u of (chatyyR.data?.users || [])) {
            if (u.email !== user?.email && !merged.has(u.email)) {
              merged.set(u.email, { ...u, isRegistered: true });
            }
          }
        }

        if (contactsR?.success) {
          for (const c of (contactsR.data || [])) {
            if (c.email !== user?.email && !merged.has(c.email)) {
              merged.set(c.email, { ...c, isRegistered: false });
            }
          }
        }

        const finalResults = Array.from(merged.values());
        setSearchResults(finalResults);
      } catch (err) {
        // search error - silently ignored
      }
      setSearching(false);
    }, 300);
  }, [user?.email, allChatyyUsers]);

  const handleSelectContact = (contact) => {
    // Pick-mode: adding this contact to an existing group. One-tap flow —
    // hit chatAddMember, toast, navigate back into the conversation.
    if (pickMode && addMemberConvId && contact?.email) {
      (async () => {
        try {
          const r = await api.chatAddMember(addMemberConvId, contact.email);
          if (r?.success) {
            router.replace({ pathname: '/chat-conversation', params: { id: String(addMemberConvId) } });
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

  const isSelected = (email) => selectedMembers.some(m => m.email === email);

  // QR code data
  const qrData = JSON.stringify({
    type: 'chatyy_contact',
    email: user?.email || '',
    name: user?.name || user?.email?.split('@')[0] || '',
  });
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`;

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

  const handleBarCodeScanned = ({ data }) => {
    if (qrScanned) return;
    setQrScanned(true);
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'chatyy_contact' && parsed.email) {
        setShowQrModal(false);
        handleCreateDirect(parsed.email, parsed.name || parsed.email);
        return;
      }
    } catch {}
    // If not a valid Chatyy QR, check if it's just an email
    if (data.includes('@') && !data.includes(' ')) {
      setShowQrModal(false);
      handleCreateDirect(data.trim(), data.trim());
      return;
    }
    safeAlert(t('chat.qrCode'), t('chat.qrInvalid'));
    // Allow scanning again after invalid QR
    setTimeout(() => setQrScanned(false), 2000);
  };

  // Share QR code as image
  const handleShareQrImage = async () => {
    const shareText = `${t('chat.qrSharePrefix')} ${user?.email}`;
    try {
      if (Platform.OS === 'web') {
        // On web: download QR image from API
        const link = document.createElement('a');
        link.download = `chatyy-qr-${(user?.email || 'contact').split('@')[0]}.png`;
        link.href = qrImageUrl;
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        safeAlert('', t('chat.qrSaved'));
      } else {
        // On native: download QR image to temp file and share
        try {
          const filename = `chatyy-qr-${Date.now()}.png`;
          const fileUri = `${FileSystem.cacheDirectory}${filename}`;
          await FileSystem.downloadAsync(qrImageUrl, fileUri);
          await Sharing.shareAsync(fileUri, {
            mimeType: 'image/png',
            dialogTitle: t('chat.qrCode'),
            UTI: 'public.png',
          });
        } catch (err) {
          // Fallback to text share
          Share.share({ message: shareText }).catch(() => {});
        }
      }
    } catch {
      // Fallback to text share
      if (Platform.OS === 'web') {
        try { await navigator.clipboard.writeText(shareText); } catch {}
        safeAlert('', t('chat.inviteCopied'));
      } else {
        Share.share({ message: shareText }).catch(() => {});
      }
    }
  };

  // Build alphabet index from allChatyyUsers
  const alphabetLetters = useMemo(() => {
    const letterSet = new Set();
    for (const u of allChatyyUsers) {
      const first = (u.name || u.email || '?')[0].toUpperCase();
      if (first >= 'A' && first <= 'Z') letterSet.add(first);
    }
    return Array.from(letterSet).sort();
  }, [allChatyyUsers]);

  // Handle alphabet press - scroll to section
  const handleAlphabetPress = useCallback((letter) => {
    if (!sectionListRef.current) return;
    // Find the section index for this letter
    const sections = buildSections();
    // The Chatyy users section (index varies)
    const chatyySection = sections.find(s => s.key === 'chatyy');
    if (!chatyySection) return;
    const sectionIdx = sections.indexOf(chatyySection);
    const itemIdx = chatyySection.data.findIndex(u => {
      const first = (u.name || u.email || '?')[0].toUpperCase();
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
  }, [allChatyyUsers]);

  // ---- Render recent contacts (horizontal scroll) ----
  const renderRecentItem = ({ item }) => (
    <TouchableOpacity
      style={sty.recentItem}
      onPress={() => handleSelectContact(item)}
      activeOpacity={0.7}
    >
      <View>
        <AvatarCircle email={item.email} name={item.name || item.email} size={56} colors={colors} />
        <View style={[sty.onlineDot, { borderColor: colors.background }]} />
      </View>
      <Text style={[sty.recentName, { color: colors.text }]} numberOfLines={1}>
        {((item.name && !item.name.includes('@')) ? item.name : prettifyHandle(item.email || item.name || '')).split(' ')[0]}
      </Text>
    </TouchableOpacity>
  );

  // ---- Render contact row ----
  const renderContact = ({ item }) => {
    // Placeholder item for web invite section
    if (item._isInvitePlaceholder) {
      return (
        <View style={[sty.contactRow, { borderBottomColor: colors.border, paddingVertical: 16 }]}>
          <View style={[sty.quickActionIcon, { backgroundColor: '#7C3AED', marginRight: 12 }]}>
            <IconUserPlus size={18} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[sty.contactName, { color: colors.text }]}>{t('chat.inviteFriend')}</Text>
            <Text style={[sty.contactSub, { color: colors.textTertiary }]}>{t('chat.inviteFriendDesc')}</Text>
          </View>
          <TouchableOpacity
            style={[sty.inviteBtn, { backgroundColor: '#7C3AED' }]}
            onPress={() => setShowInviteInput(true)}
            activeOpacity={0.7}
          >
            <Text style={sty.inviteBtnText}>{t('chat.invite')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const selected = isSelected(item.email);
    const isChatyyUser = item.isRegistered === true;

    // Non-registered contact - show invite options
    if (!isChatyyUser) {
      return (
        <View style={[sty.contactRow, { borderBottomColor: colors.border }]}>
          <AvatarCircle email={item.email || ''} name={item.name || item.phone || '?'} size={48} colors={colors} />
          <View style={sty.contactInfo}>
            <HighlightText
              text={item.name || item.phone || '?'}
              highlight={searchText}
              style={[sty.contactName, { color: colors.text }]}
              highlightStyle={{ backgroundColor: '#7C3AED30', fontWeight: '700' }}
            />
            <Text style={[sty.contactSub, { color: colors.textTertiary }]} numberOfLines={1}>
              {item.email || item.phone || ''}
            </Text>
          </View>
          {(() => {
            // Unified single-pill invite. Was 3 stacked pills (email + share + W)
            // which the user flagged as cluttered (print 2). Now: ONE pill that
            // picks the best channel automatically; long-press surfaces choices.
            // Email wins when available (higher delivery, less noise);
            // otherwise share-sheet on native, copy-link on web.
            const hasEmail = !!item.email;
            const hasPhone = !!item.phone && Platform.OS !== 'web';
            const onTap = () => {
              if (hasEmail) handleInviteByEmail(item.email, item.name);
              else handleInviteShare(item);
            };
            const onHold = () => {
              if (Platform.OS === 'ios') {
                const opts = [];
                const actions = [];
                if (hasEmail) { opts.push(t('chat.inviteByEmail') || 'Convidar por email'); actions.push(() => handleInviteByEmail(item.email, item.name)); }
                if (hasPhone) { opts.push('WhatsApp'); actions.push(() => handleInviteViaWhatsApp(item)); }
                opts.push(t('chat.inviteShare') || 'Compartilhar link');
                actions.push(() => handleInviteShare(item));
                opts.push(t('common.cancel') || 'Cancelar');
                ActionSheetIOS.showActionSheetWithOptions(
                  { options: opts, cancelButtonIndex: opts.length - 1 },
                  (idx) => { if (idx >= 0 && idx < actions.length) actions[idx](); }
                );
              } else {
                handleInviteShare(item);
              }
            };
            return (
              <TouchableOpacity
                style={[sty.inviteBtn, { backgroundColor: '#7C3AED' }]}
                onPress={onTap}
                onLongPress={onHold}
                disabled={invitingEmail === item.email}
                activeOpacity={0.7}
                accessibilityLabel={t('chat.invite')}
              >
                {invitingEmail === item.email ? (
                  <ActivityIndicator size={14} color="#fff" />
                ) : (
                  <Text style={sty.inviteBtnText}>{t('chat.invite')}</Text>
                )}
              </TouchableOpacity>
            );
          })()}
        </View>
      );
    }

    // Registered Chatyy user
    return (
      <TouchableOpacity
        style={[sty.contactRow, { borderBottomColor: colors.border }]}
        onPress={() => handleSelectContact(item)}
        activeOpacity={0.7}
      >
        <View>
          <AvatarCircle email={item.email} name={item.name || prettifyHandle(item.email)} size={48} colors={colors} />
          {item.online && <View style={[sty.onlineDotSmall, { borderColor: colors.background }]} />}
        </View>
        <View style={sty.contactInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <HighlightText
              text={item.name && !item.name.includes('@') ? item.name : prettifyHandle(item.email || item.name || '')}
              highlight={searchText}
              style={[sty.contactName, { color: colors.text }]}
              highlightStyle={{ backgroundColor: '#7C3AED30', fontWeight: '700' }}
            />
            {/* CHATYY badge removed from every row — the list already lives under the
                "Contatos no Chatyy" section header, so tagging each row was noisy. The
                presence of the row + the @username pill already signals Chatyy-user. */}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <HighlightText
              text={item.email}
              highlight={searchText}
              style={[sty.contactSub, { color: colors.textTertiary }]}
              highlightStyle={{ backgroundColor: '#7C3AED30' }}
            />
            {item.username ? (
              <Text style={{ fontSize: 12, color: '#7C3AED', fontWeight: '600' }}>@{item.username}</Text>
            ) : null}
          </View>
          {item.about ? (
            <Text style={[sty.contactAbout, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.about}
            </Text>
          ) : item.last_seen ? (
            <Text style={[sty.contactAbout, { color: colors.textTertiary }]} numberOfLines={1}>
              {t('chat.lastSeen')} {formatLastSeen(item.last_seen)}
            </Text>
          ) : null}
        </View>
        {(mode === 'group' || mode === 'channel') && item.email && (
          <View style={[sty.checkbox, {
            backgroundColor: selected ? colors.primary : 'transparent',
            borderColor: selected ? colors.primary : colors.border,
          }]}>
            {selected && <IconCheck size={14} color="#fff" />}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Format last seen time
  function formatLastSeen(dateStr) {
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

  // sections and buildSections moved before handleSearch to avoid TDZ

  const isLoading = syncingContacts || (loadingRecents && loadingDirectory);

  return (
    <View style={[sty.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[sty.header, { backgroundColor: isDark ? '#1F2C33' : '#6D28D9' }]}>
        <TouchableOpacity onPress={() => router.back()} style={[sty.headerBtn, { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20 }]}>
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={[sty.headerTitle, { color: '#fff' }]}>{t('chat.newConversation')}</Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {/* QR Code button */}
          <TouchableOpacity
            onPress={handleQrPress}
            style={[sty.headerBtn, { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20 }]}
            accessibilityLabel={t('chat.qrCode')}
            accessibilityRole="button"
          >
            <IconQrCode size={22} color="#fff" />
          </TouchableOpacity>
          {/* Manual refresh button (native only) */}
          {Platform.OS !== 'web' && (
            <TouchableOpacity
              onPress={doContactSync}
              style={[sty.headerBtn, { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20 }]}
              disabled={syncingContacts}
              accessibilityLabel={t('chat.refreshContacts')}
              accessibilityRole="button"
            >
              {syncingContacts ? (
                <ActivityIndicator size={18} color="rgba(255,255,255,0.6)" />
              ) : (
                <IconRefresh size={20} color="#fff" />
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Mode Toggle */}
      <View style={[sty.toggleRow, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
        <TouchableOpacity
          style={[sty.toggleBtn, mode === 'direct' && [sty.toggleBtnActive, { backgroundColor: '#7C3AED' }]]}
          onPress={() => { setMode('direct'); setSelectedMembers([]); }}
        >
          <IconMessageSquare size={15} color={mode === 'direct' ? '#fff' : colors.textSecondary} />
          <Text style={[sty.toggleText, { color: mode === 'direct' ? '#fff' : colors.textSecondary }]}>
            {t('chat.direct')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sty.toggleBtn, mode === 'group' && [sty.toggleBtnActive, { backgroundColor: '#7C3AED' }]]}
          onPress={() => setMode('group')}
        >
          <IconUsers size={15} color={mode === 'group' ? '#fff' : colors.textSecondary} />
          <Text style={[sty.toggleText, { color: mode === 'group' ? '#fff' : colors.textSecondary }]}>
            {t('chat.group')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sty.toggleBtn, mode === 'channel' && [sty.toggleBtnActive, { backgroundColor: '#7C3AED' }]]}
          onPress={() => setMode('channel')}
        >
          <Text style={{ fontSize: 13, marginRight: 3 }}>{'#'}</Text>
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

      {/* Search Input */}
      <View style={[sty.searchWrap, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
        <IconSearch size={18} color={colors.textTertiary} />
        <TextInput
          style={[sty.searchInput, { color: colors.text }]}
          placeholder={t('chat.searchOrType')}
          placeholderTextColor={colors.textTertiary}
          value={searchText}
          onChangeText={handleSearch}
          onSubmitEditing={handleAddEmail}
          autoFocus
          keyboardType="default"
          autoCapitalize="none"
        />
        {searchText ? (
          <TouchableOpacity onPress={() => { setSearchText(''); setSearchResults([]); }} style={{ padding: 4 }}>
            <IconX size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Content */}
      {isLoading && !searchText && recentContacts.length === 0 ? (
        <View style={sty.loaderWrap} />
      ) : searchText.length >= 1 ? (
        /* Search results */
        searching ? (
          <View style={sty.loaderWrap}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={searchResults}
            keyExtractor={(item, i) => item.email || String(i)}
            renderItem={renderContact}
            contentContainerStyle={sty.contactList}
            ListEmptyComponent={(() => {
              // Phone-shaped query with no matches → this number isn't on Chatyy yet.
              // Offer to invite via SMS/share sheet directly from here.
              const digits = (searchText || '').replace(/\D/g, '');
              const isPhoneQuery = digits.length >= 8 &&
                digits.length === (searchText || '').replace(/[\s+()\-.]/g, '').length;
              return (
                <View style={sty.emptyResults}>
                  <View style={[sty.emptyIconCircle, { backgroundColor: isDark ? '#1e1e1e' : '#f2f2f7' }]}>
                    <IconSearch size={32} color={colors.textTertiary} />
                  </View>
                  <Text style={[sty.emptyTitle, { color: colors.text }]}>
                    {isPhoneQuery
                      ? (t('chat.phoneNotOnChatyy') || 'Este número ainda não usa o Chatyy')
                      : t('chat.noContactsFound')}
                  </Text>
                  <Text style={[sty.emptyText, { color: colors.textTertiary }]}>
                    {isPhoneQuery
                      ? (t('chat.inviteViaSms') || 'Convide pra conversarem por aqui.')
                      : t('chat.tryDifferentSearch')}
                  </Text>
                  {isPhoneQuery && (
                    <TouchableOpacity
                      style={[sty.emptyActionBtn, { backgroundColor: '#7C3AED', marginTop: 16 }]}
                      onPress={() => handleInviteShare({ phone: searchText.trim() })}
                    >
                      <IconUserPlus size={16} color="#fff" />
                      <Text style={sty.emptyActionText}>
                        {t('chat.invitePhone') || 'Convidar este número'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {searchText.includes('@') && (
                    <View style={{ gap: 10, marginTop: 16, alignItems: 'center' }}>
                      {mode !== 'direct' && (
                        <TouchableOpacity
                          style={[sty.emptyActionBtn, { backgroundColor: colors.primary }]}
                          onPress={handleAddEmail}
                        >
                          <IconPlus size={16} color="#fff" />
                          <Text style={sty.emptyActionText}>{t('chat.addEmail', { email: searchText })}</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={[sty.emptyActionBtn, { backgroundColor: '#7C3AED' }]}
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
              renderSectionHeader={({ section: { title } }) => (
                <View style={[sty.sectionHeader, { backgroundColor: isDark ? '#111' : '#f8f8fa' }]}>
                  <View style={sty.sectionAccentLine} />
                  <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>{title}</Text>
                </View>
              )}
              contentContainerStyle={sty.contactList}
              stickySectionHeadersEnabled
              ListHeaderComponent={
                <View>
                  {/* Recently contacted (horizontal scroll) */}
                  {recentContacts.length > 0 && (
                    <View style={sty.recentSection}>
                      <View style={[sty.sectionHeader, { backgroundColor: 'transparent', paddingBottom: 4 }]}>
                        <View style={sty.sectionAccentLine} />
                        <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>
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
                      <View style={[sty.quickActionIcon, { backgroundColor: '#0ea5e9' }]}>
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
                      <View style={[sty.quickActionIcon, { backgroundColor: '#7C3AED' }]}>
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
                          style={[sty.inviteSendBtn, { backgroundColor: inviteEmail.includes('@') ? '#7C3AED' : colors.border }]}
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
                      <View style={[sty.quickActionIcon, { backgroundColor: '#6366f1' }]}>
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
                    <View style={[sty.inviteCountBanner, { backgroundColor: isDark ? '#1a2e1a' : '#f0faf3' }]}>
                      <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                        {t('chat.contactsNotOnChatyy', { count: otherContacts.length })}
                      </Text>
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
            {creating ? <ActivityIndicator size="small" color="#fff" /> : (
              <>
                <IconUsers size={18} color="#fff" />
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
            {creating ? <ActivityIndicator size="small" color="#fff" /> : (
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
                    <Image
                      source={{ uri: qrImageUrl }}
                      style={{ width: 180, height: 180 }}
                      resizeMode="contain"
                    />
                  </View>
                  <Text style={{ fontSize: 12, color: '#999', marginTop: 12, textAlign: 'center' }}>
                    {t('chat.qrShareDesc')}
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                  <TouchableOpacity
                    style={[sty.qrActionBtn, { backgroundColor: '#7C3AED' }]}
                    onPress={handleQrScan}
                  >
                    <IconSearch size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{t('chat.qrScan')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[sty.qrActionBtn, { backgroundColor: '#6366f1' }]}
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
                  style={[sty.qrActionBtn, { backgroundColor: '#7C3AED', marginTop: 16, alignSelf: 'stretch' }]}
                  onPress={() => setQrMode('show')}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{t('chat.qrShowMine')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const sty = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: 0,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 20, fontWeight: '600', letterSpacing: 0, flex: 1, textAlign: 'center' },
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
      web: { boxShadow: '0 2px 8px rgba(124,58,237,0.25)' },
      default: {},
    }),
    elevation: 3,
    shadowColor: '#7C3AED',
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
    backgroundColor: '#7C3AED', borderWidth: 2,
  },
  onlineDotSmall: {
    position: 'absolute', bottom: 0, right: 0,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#7C3AED', borderWidth: 2,
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
    backgroundColor: '#7C3AED',
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
    backgroundColor: '#7C3AED',
    ...Platform.select({
      web: { boxShadow: '0 1px 3px rgba(124,58,237,0.3)' },
      default: {},
    }),
    elevation: 2,
    shadowColor: '#7C3AED',
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

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 8, gap: 8,
  },
  sectionAccentLine: {
    width: 0, height: 0,
  },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, color: '#6D28D9' },
  createBtnWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, height: 50, borderRadius: 25,
    backgroundColor: '#7C3AED',
    ...Platform.select({
      web: { boxShadow: '0 3px 12px rgba(124,58,237,0.3)' },
      default: {},
    }),
    elevation: 4,
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  createBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },

  // Alphabet sidebar
  alphabetSidebar: {
    position: 'absolute', right: 2, top: 0, bottom: 0,
    justifyContent: 'center', zIndex: 10,
  },
  alphabetInner: {
    paddingVertical: 4, alignItems: 'center',
  },
  alphabetLetter: { paddingVertical: 1, paddingHorizontal: 6 },
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
    width: 200, height: 200, borderWidth: 2, borderColor: '#7C3AED',
    borderRadius: 16, backgroundColor: 'transparent',
  },
  qrActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, height: 44, borderRadius: 22,
    justifyContent: 'center', flex: 1,
  },
});
