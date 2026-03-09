import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, RefreshControl, TextInput, Alert,
  Animated, PanResponder, Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as api from '../services/api';
import { IconMessageSquare, IconSearch, IconX, IconTrash, IconArchive, IconVolume2 } from './Icons';
import AvatarCircle from './AvatarCircle';

function formatChatTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr + 'Z');
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Ontem';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Pin icon (simple SVG)
function IconPin({ size = 24, color = '#666' }) {
  const Svg = require('react-native-svg').default;
  const { Path } = require('react-native-svg');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 17v5" />
      <Path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7" />
      <Path d="M6 11h12l-1.5 6h-9L6 11z" />
    </Svg>
  );
}

function ConversationRow({ conversation, colors, onPress, onDelete, onArchive, onMute, onPin, currentEmail, t, presences, isDark }) {
  const isGroup = conversation.type === 'group';
  const displayName = conversation.name || t('chat.unknown');
  const unread = conversation.unread_count > 0;
  const lastMsg = conversation.last_message;
  const isArchived = conversation.archived;

  const otherMember = !isGroup ? (conversation.members || []).find(m => m !== currentEmail && m.email !== currentEmail) : null;
  const otherEmail = otherMember ? (typeof otherMember === 'string' ? otherMember : otherMember?.email) : null;

  let isOnline = false;
  if (!isGroup && presences && otherEmail) {
    const p = presences.find(pr => pr.email === otherEmail);
    isOnline = p?.status === 'online';
  }

  let preview = '';
  if (lastMsg) {
    let checkMark = '';
    if (lastMsg.sender_email === currentEmail) {
      if (lastMsg.read_at) checkMark = '\u2713\u2713 ';
      else if (lastMsg.delivered_at) checkMark = '\u2713\u2713 ';
      else checkMark = '\u2713 ';
    }

    let content = lastMsg.content || '';
    if (content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.call_type === 'video') content = '\uD83D\uDCF9 ' + (t('chat.videoCall') || 'Chamada de video');
        else if (parsed.call_type === 'audio') content = '\uD83D\uDCDE ' + (t('chat.voiceCall') || 'Chamada de voz');
        else if (parsed.type === 'location') content = '\uD83D\uDCCD ' + (t('chat.location') || 'Localiza\u00E7\u00E3o');
        else if (parsed.type === 'contact') content = '\uD83D\uDC64 ' + (t('chat.contact') || 'Contato');
        else content = '\uD83D\uDCCE ' + (t('chat.attachment') || 'Anexo');
      } catch {}
    }
    if (lastMsg.type === 'image') content = '\uD83D\uDCF7 ' + (t('chat.photo') || 'Foto');
    else if (lastMsg.type === 'video' && !content.startsWith('\uD83C\uDFA5')) content = '\uD83C\uDFA5 ' + (t('chat.video') || 'V\u00EDdeo');
    else if (lastMsg.type === 'audio' && !content.startsWith('\uD83D\uDCDE')) content = '\uD83C\uDFB5 ' + (t('chat.audio') || '\u00C1udio');
    else if (lastMsg.type === 'file') content = '\uD83D\uDCCE ' + (lastMsg.file_name || t('chat.file') || 'Arquivo');

    if (lastMsg.type === 'system') {
      preview = content;
    } else if (isGroup && lastMsg.sender_email !== currentEmail) {
      const sender = lastMsg.sender_name || lastMsg.sender_email?.split('@')[0] || '';
      preview = `~${sender}: ${content}`;
    } else {
      preview = checkMark + content;
    }
  }

  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 15 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        // Allow both left (negative) and right (positive) swipes
        translateX.setValue(Math.max(Math.min(g.dx, 160), -160));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -70 || g.vx < -0.5) {
          // Swiped left — show archive + delete
          Animated.timing(translateX, { toValue: -160, duration: 150, useNativeDriver: false }).start();
        } else if (g.dx > 70 || g.vx > 0.5) {
          // Swiped right — show mute + pin
          Animated.timing(translateX, { toValue: 160, duration: 150, useNativeDriver: false }).start();
        } else {
          Animated.timing(translateX, { toValue: 0, duration: 150, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  const resetSwipe = () => { Animated.timing(translateX, { toValue: 0, duration: 150, useNativeDriver: false }).start(); };

  return (
    <View style={s.swipeContainer}>
      {/* Left actions (revealed on swipe right): Mute + Pin */}
      <View style={[s.swipeActionsLeft]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#6B7280' }]} onPress={() => { resetSwipe(); onMute?.(conversation); }}>
          <IconVolume2 size={20} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.mute') || 'Mute'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#F59E0B' }]} onPress={() => { resetSwipe(); onPin?.(conversation); }}>
          <IconPin size={20} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.pin') || 'Pin'}</Text>
        </TouchableOpacity>
      </View>
      {/* Right actions (revealed on swipe left): Archive + Delete */}
      <View style={[s.swipeActionsRight]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#3B82F6' }]} onPress={() => { resetSwipe(); onArchive?.(conversation); }}>
          <IconArchive size={20} color="#fff" />
          <Text style={s.swipeActionLabel}>{isArchived ? (t('chat.unarchive') || 'Unarchive') : (t('chat.archive') || 'Archive')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#EF4444' }]} onPress={() => { resetSwipe(); onDelete?.(conversation); }}>
          <IconTrash size={20} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.delete') || 'Delete'}</Text>
        </TouchableOpacity>
      </View>
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }], backgroundColor: colors.background }}>
        <TouchableOpacity style={[s.row, { backgroundColor: colors.background }]} onPress={() => { resetSwipe(); onPress(); }} activeOpacity={0.65}>
          <View style={s.avatarWrap}>
            <AvatarCircle name={displayName} email={otherEmail} size={52} />
            {isOnline && <View style={[s.onlineDot, { borderColor: colors.background }]} />}
          </View>
          <View style={s.rowContent}>
            <View style={s.rowTop}>
              <Text style={[s.rowName, { color: colors.text }, unread && s.rowNameUnread]} numberOfLines={1}>{displayName}</Text>
              <Text style={[s.rowTime, unread ? { color: '#25D366' } : { color: colors.textTertiary }]}>
                {lastMsg ? formatChatTime(lastMsg.created_at) : ''}
              </Text>
            </View>
            <View style={s.rowBottom}>
              <Text style={[s.rowPreview, { color: colors.textSecondary }]} numberOfLines={1}>{preview || t('chat.noMessages')}</Text>
              {unread && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {conversation.has_mention && (
                    <View style={[s.unreadBadge, { minWidth: 22, backgroundColor: '#25D366' }]}>
                      <Text style={s.unreadText}>@</Text>
                    </View>
                  )}
                  <View style={s.unreadBadge}>
                    <Text style={s.unreadText}>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</Text>
                  </View>
                </View>
              )}
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

export default function ChatListTab({ colors, isDark, t, user, router }) {
  const [conversations, setConversations] = useState([]);
  const [archivedConversations, setArchivedConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState('all');
  const [presences, setPresences] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  const loadConversations = useCallback(async (showLoader) => {
    if (showLoader) setLoading(true);
    try {
      // Load non-archived
      const r = await api.chatConversations(searchText, false);
      if (r.success) {
        setConversations(Array.isArray(r.data) ? r.data : (r.data?.conversations || []));
      }
      // Load archived
      const rAll = await api.chatConversations(searchText, true);
      if (rAll.success) {
        const all = Array.isArray(rAll.data) ? rAll.data : (rAll.data?.conversations || []);
        setArchivedConversations(all.filter(c => c.archived));
      }
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [searchText]);

  useEffect(() => { loadConversations(true); }, [loadConversations]);

  useEffect(() => {
    api.chatPresence('online').then(r => { if (r.success && r.data) setPresences(r.data); }).catch(() => {});
    const interval = setInterval(() => {
      api.chatPresence('online').then(r => { if (r.success && r.data) setPresences(r.data); }).catch(() => {});
    }, 20000);
    return () => clearInterval(interval);
  }, []);

  useFocusEffect(useCallback(() => { loadConversations(false); }, [loadConversations]));

  const onRefresh = useCallback(() => { setRefreshing(true); loadConversations(false); }, [loadConversations]);

  const handleConversationPress = (conv) => {
    const otherMember = conv.type === 'direct' && conv.members ? conv.members.find(m => m.email !== user?.email) : null;
    const emailParam = otherMember ? `&email=${encodeURIComponent(otherMember.email)}` : '';
    router.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(conv.name || '')}&type=${conv.type}${emailParam}`);
  };

  const handleDeleteConversation = (conv) => {
    Alert.alert(t('chat.deleteConversation'), t('chat.deleteConversationConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.delete'), style: 'destructive',
        onPress: async () => {
          try {
            const r = await api.chatDeleteConversation(conv.id);
            if (r.success) {
              setConversations(prev => prev.filter(c => c.id !== conv.id));
              setArchivedConversations(prev => prev.filter(c => c.id !== conv.id));
            }
            else Alert.alert(t('chat.deleteConversationError'));
          } catch { Alert.alert(t('chat.deleteConversationError')); }
        },
      },
    ]);
  };

  const handleArchiveConversation = async (conv) => {
    const newArchived = !conv.archived;
    try {
      const r = await api.chatArchive(conv.id, newArchived);
      if (r.success) {
        if (newArchived) {
          // Move from conversations to archived
          setConversations(prev => prev.filter(c => c.id !== conv.id));
          setArchivedConversations(prev => [...prev, { ...conv, archived: 1 }]);
        } else {
          // Move from archived to conversations
          setArchivedConversations(prev => prev.filter(c => c.id !== conv.id));
          setConversations(prev => [{ ...conv, archived: 0 }, ...prev]);
        }
      }
    } catch {}
  };

  const handleMuteConversation = async (conv) => {
    try {
      await api.chatMute(conv.id);
      loadConversations(false);
    } catch {}
  };

  const handlePinConversation = async (conv) => {
    try {
      await api.chatPin(conv.id);
      loadConversations(false);
    } catch {}
  };

  const unreadCount = conversations.filter(c => c.unread_count > 0).length;
  const groupCount = conversations.filter(c => c.type === 'group').length;
  const archivedCount = archivedConversations.length;

  const getFilteredConversations = () => {
    if (filter === 'archived') return archivedConversations;
    return conversations.filter(c => {
      if (filter === 'unread') return c.unread_count > 0;
      if (filter === 'groups') return c.type === 'group';
      return true;
    });
  };

  const filteredConversations = getFilteredConversations();

  const FilterChip = ({ label, value, count }) => {
    const active = filter === value;
    return (
      <TouchableOpacity
        style={[s.chip, active ? { backgroundColor: '#25D366' } : { backgroundColor: isDark ? '#2a2a2a' : '#f0f0f0' }]}
        onPress={() => setFilter(filter === value ? 'all' : value)}
        activeOpacity={0.7}
      >
        <Text style={[s.chipText, active ? { color: '#fff' } : { color: colors.text }]}>
          {label}{count > 0 ? ` ${count}` : ''}
        </Text>
      </TouchableOpacity>
    );
  };

  // Archived section header (shown at top of list when not in archived filter)
  const renderArchivedHeader = () => {
    if (filter !== 'all' || archivedCount === 0) return null;
    return (
      <TouchableOpacity
        style={[s.archivedHeader, { borderBottomColor: colors.border }]}
        onPress={() => setFilter('archived')}
        activeOpacity={0.7}
      >
        <View style={s.archivedHeaderIcon}>
          <IconArchive size={20} color={colors.textSecondary} />
        </View>
        <Text style={[s.archivedHeaderText, { color: colors.text }]}>
          {t('chat.archived') || 'Arquivadas'} ({archivedCount})
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Search */}
      <View style={s.searchWrap}>
        <View style={[s.searchBar, { backgroundColor: isDark ? '#2a2a2a' : '#f0f0f0' }]}>
          <IconSearch size={16} color={colors.textTertiary} />
          <TextInput
            style={[s.searchInput, { color: colors.text }]}
            placeholder={t('chat.searchPlaceholder') || 'Pesquisar'}
            placeholderTextColor={colors.textTertiary}
            value={searchText}
            onChangeText={setSearchText}
            onSubmitEditing={() => loadConversations(true)}
            returnKeyType="search"
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={() => setSearchText('')}><IconX size={16} color={colors.textTertiary} /></TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filters */}
      <View style={s.filtersRow}>
        <FilterChip label={t('chat.filterAll') || 'Todas'} value="all" />
        <FilterChip label={t('chat.filterUnread') || 'N\u00E3o lidas'} value="unread" count={unreadCount} />
        <FilterChip label={t('chat.filterGroups') || 'Grupos'} value="groups" count={groupCount} />
        <FilterChip label={t('chat.filterArchived') || 'Arquivadas'} value="archived" count={archivedCount} />
      </View>

      {/* List */}
      {loading && !refreshing ? (
        <View style={s.loaderWrap}><ActivityIndicator size="large" color="#25D366" /></View>
      ) : (
        <FlatList
          data={filteredConversations}
          keyExtractor={(item) => String(item.id)}
          ListHeaderComponent={renderArchivedHeader}
          renderItem={({ item }) => (
            <ConversationRow conversation={item} colors={colors} isDark={isDark} t={t}
              onPress={() => handleConversationPress(item)}
              onDelete={handleDeleteConversation}
              onArchive={handleArchiveConversation}
              onMute={handleMuteConversation}
              onPin={handlePinConversation}
              currentEmail={user?.email} presences={presences} />
          )}
          ListEmptyComponent={() => loading ? null : (
            <View style={s.emptyContainer}>
              <IconMessageSquare size={64} color={colors.textTertiary} />
              <Text style={[s.emptyTitle, { color: colors.text }]}>{t('chat.empty')}</Text>
              <Text style={[s.emptySubtitle, { color: colors.textSecondary }]}>{t('chat.emptyDesc')}</Text>
            </View>
          )}
          contentContainerStyle={[filteredConversations.length === 0 && s.listEmpty]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#25D366" />}
          ItemSeparatorComponent={() => <View style={[s.separator, { backgroundColor: colors.border, marginLeft: 82 }]} />}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={[s.fab, { bottom: 80 }]}
        onPress={() => router.push('/chat-new')}
        activeOpacity={0.85}
      >
        <IconMessageSquare size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  searchWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  searchBar: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 12, height: 36, gap: 8 },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  filtersRow: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 18 },
  chipText: { fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  avatarWrap: { position: 'relative', marginRight: 14 },
  onlineDot: { position: 'absolute', bottom: 1, right: 1, width: 14, height: 14, borderRadius: 7, backgroundColor: '#25D366', borderWidth: 2 },
  rowContent: { flex: 1 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  rowName: { fontSize: 16, fontWeight: '500', flex: 1, marginRight: 8 },
  rowNameUnread: { fontWeight: '700' },
  rowTime: { fontSize: 12 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowPreview: { fontSize: 14, flex: 1, marginRight: 8 },
  unreadBadge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  unreadText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth },
  swipeContainer: { position: 'relative', overflow: 'hidden' },
  swipeActionsLeft: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 160,
    flexDirection: 'row',
  },
  swipeActionsRight: {
    position: 'absolute', right: 0, top: 0, bottom: 0, width: 160,
    flexDirection: 'row',
  },
  swipeActionBtnWide: {
    width: 80, alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  swipeActionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },
  archivedHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  archivedHeaderIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center',
    marginRight: 14,
  },
  archivedHeaderText: { fontSize: 15, fontWeight: '600' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginTop: 16 },
  emptySubtitle: { fontSize: 14, textAlign: 'center', marginTop: 6 },
  listEmpty: { flexGrow: 1 },
  fab: {
    position: 'absolute', right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: '#25D366',
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8 },
      android: { elevation: 6 },
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
    }),
  },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
