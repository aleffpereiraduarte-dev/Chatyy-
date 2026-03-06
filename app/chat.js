import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, RefreshControl, TextInput, Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import {
  IconMessageSquare, IconPlus, IconArrowLeft, IconSearch, IconX,
} from '../components/Icons';

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr + 'Z');
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s@]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name[0].toUpperCase();
}

function AvatarCircle({ name, size = 48, colors }) {
  const initials = getInitials(name);
  // Generate a consistent color from the name
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const bgColor = `hsl(${hue}, 55%, 55%)`;

  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.38 }]}>{initials}</Text>
    </View>
  );
}

function ConversationCard({ conversation, colors, onPress, currentEmail, t, presences }) {
  const isGroup = conversation.type === 'group';
  const displayName = conversation.name || t('chat.unknown');
  const unread = conversation.unread_count > 0;
  const lastMsg = conversation.last_message;

  // Check if the other person is online (for direct chats)
  let isOnline = false;
  if (!isGroup && presences) {
    const otherEmail = (conversation.members || []).find(m => m !== currentEmail && m.email !== currentEmail);
    const emailStr = typeof otherEmail === 'string' ? otherEmail : otherEmail?.email;
    if (emailStr) {
      const p = presences.find(pr => pr.email === emailStr);
      isOnline = p?.status === 'online';
    }
  }

  let preview = '';
  if (lastMsg) {
    if (lastMsg.type === 'system') {
      preview = lastMsg.content;
    } else {
      const sender = lastMsg.sender_email === currentEmail ? t('chat.you') : (lastMsg.sender_name || lastMsg.sender_email.split('@')[0]);
      const prefix = isGroup ? `${sender}: ` : (lastMsg.sender_email === currentEmail ? `${t('chat.you')}: ` : '');
      preview = prefix + (lastMsg.content || '');
    }
  }

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border },
        unread && { borderLeftWidth: 3, borderLeftColor: colors.primary }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View>
        <AvatarCircle name={displayName} size={48} colors={colors} />
        {isOnline && (
          <View style={styles.onlineDot} />
        )}
      </View>
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <Text
            style={[styles.cardName, { color: colors.text }, unread && styles.cardNameBold]}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <Text style={[styles.cardTime, { color: unread ? colors.primary : colors.textTertiary }]}>
            {lastMsg ? relativeTime(lastMsg.created_at) : ''}
          </Text>
        </View>
        <View style={styles.cardFooter}>
          <Text
            style={[styles.cardPreview, { color: unread ? colors.text : colors.textSecondary },
              unread && styles.cardPreviewBold]}
            numberOfLines={1}
          >
            {preview || t('chat.noMessages')}
          </Text>
          {unread && (
            <View style={[styles.unreadBadge, { backgroundColor: colors.primary }]}>
              <Text style={styles.unreadText}>
                {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
              </Text>
            </View>
          )}
        </View>
        {isGroup && (
          <Text style={[styles.cardMemberCount, { color: colors.textTertiary }]}>
            {t('chat.memberCount', { count: conversation.member_count || (conversation.members || []).length || 0 })}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

class ChatErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Chat Error</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function ChatScreenWrapper() {
  return (
    <ChatErrorBoundary>
      <ChatScreenInner />
    </ChatErrorBoundary>
  );
}

function ChatScreenInner() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [presences, setPresences] = useState([]);

  const loadConversations = useCallback(async (showLoader) => {
    if (showLoader) setLoading(true);
    try {
      const r = await api.chatConversations(searchText);
      if (r.success) {
        setConversations(Array.isArray(r.data) ? r.data : (r.data?.conversations || []));
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [searchText]);

  useEffect(() => { loadConversations(true); }, [loadConversations]);

  // Load presence info
  useEffect(() => {
    api.chatPresence('online').then(r => {
      if (r.success && r.data) setPresences(r.data);
    }).catch(() => {});
    const interval = setInterval(() => {
      api.chatPresence('online').then(r => {
        if (r.success && r.data) setPresences(r.data);
      }).catch(() => {});
    }, 20000);
    return () => clearInterval(interval);
  }, []);

  // Reload when screen gets focus (e.g. coming back from conversation — clears unread badge)
  useFocusEffect(useCallback(() => {
    loadConversations(false);
  }, [loadConversations]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadConversations(false);
  }, [loadConversations]);

  const handleConversationPress = (conv) => {
    router.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(conv.name || '')}&type=${conv.type}`);
  };

  const handleNewChat = () => {
    router.push('/chat-new');
  };

  const filteredConversations = conversations;

  const renderItem = ({ item }) => (
    <ConversationCard
      conversation={item}
      colors={colors}
      t={t}
      onPress={() => handleConversationPress(item)}
      currentEmail={user?.email}
      presences={presences}
    />
  );

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <IconMessageSquare size={64} color={colors.textTertiary} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('chat.empty')}</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          {t('chat.emptyDesc')}
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        {showSearch ? (
          <View style={[styles.searchBar, { backgroundColor: colors.surfaceVariant || colors.surface, borderColor: colors.border }]}>
            <IconSearch size={16} color={colors.textTertiary} />
            <TextInput
              style={[styles.searchInput, { color: colors.text }]}
              placeholder={t('chat.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={searchText}
              onChangeText={setSearchText}
              autoFocus
              onSubmitEditing={() => loadConversations(true)}
            />
            <TouchableOpacity onPress={() => { setShowSearch(false); setSearchText(''); }}>
              <IconX size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('chat.title')}</Text>
            <TouchableOpacity onPress={() => setShowSearch(true)} style={styles.headerBtn}>
              <IconSearch size={20} color={colors.text} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Conversation List */}
      {loading && !refreshing ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filteredConversations}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={[styles.list, filteredConversations.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

      {/* FAB — New Chat */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 20 }, Shadow.md]}
        onPress={handleNewChat}
      >
        <IconPlus size={24} color="#fff" />
      </TouchableOpacity>
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
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700', flex: 1, textAlign: 'center' },
  searchBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    height: 38, borderWidth: 1, marginHorizontal: Spacing.xs,
    gap: 6,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, padding: 0 },
  list: { padding: Spacing.sm },
  listEmpty: { flexGrow: 1 },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: Spacing.xs,
    ...Shadow.sm,
    gap: Spacing.md,
  },
  avatar: {
    alignItems: 'center', justifyContent: 'center',
  },
  onlineDot: {
    position: 'absolute', bottom: 1, right: 1,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#10b981', borderWidth: 2, borderColor: '#fff',
  },
  avatarText: { color: '#fff', fontWeight: '600' },
  cardContent: { flex: 1 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  cardName: { fontSize: FontSize.md, fontWeight: '500', flex: 1, marginRight: 8 },
  cardNameBold: { fontWeight: '700' },
  cardTime: { fontSize: FontSize.xs },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardPreview: { fontSize: FontSize.sm, flex: 1, marginRight: 8 },
  cardPreviewBold: { fontWeight: '600' },
  unreadBadge: {
    minWidth: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  cardMemberCount: { fontSize: FontSize.xs, marginTop: 2 },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', marginTop: Spacing.md },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },
  fab: {
    position: 'absolute', right: 20,
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
  },
});
