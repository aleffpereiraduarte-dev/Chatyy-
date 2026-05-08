import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  Platform, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconArrowLeft } from '../../components/Icons';
import AvatarCircle from '../../components/AvatarCircle';
import * as api from '../../services/api';

// Telegram-style hashtag results screen — public-channel scoped.
// Route: /hashtag/<tag>. Receives the tag via params, calls
// chatHashtagSearch, renders rows linking to the originating channel.
export default function ChatHashtagScreen() {
  const { tag: rawTag } = useLocalSearchParams();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  // Strip leading # and clamp length the same way the indexer does so the
  // header label always matches what the server matched against.
  const tag = String(rawTag || '').replace(/^#/, '').toLowerCase().slice(0, 50);

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const load = useCallback(async () => {
    if (!tag) return;
    setErrorMsg('');
    setLoading(true);
    try {
      const r = await api.chatHashtagSearch(tag);
      if (r?.success && Array.isArray(r.data?.messages)) {
        setMessages(r.data.messages);
      } else {
        setMessages([]);
        if (r && !r.success) setErrorMsg(r.message || 'Failed to load results');
      }
    } catch (e) {
      setErrorMsg(String(e?.message || e));
      setMessages([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tag]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const openConversation = useCallback((m) => {
    if (!m?.conversation_id) return;
    router.push({
      pathname: '/chat-conversation',
      params: {
        id: String(m.conversation_id),
        name: m.conversation_name || m.conversation_handle || '',
        type: 'channel',
        // Pass the message id so the conversation can scroll/highlight
        // it when supported (no-op when not).
        scrollToMessageId: String(m.id),
      },
    });
  }, [router]);

  const renderItem = ({ item }) => {
    const dt = (() => {
      try {
        const d = new Date(item.created_at);
        if (Number.isNaN(d.getTime())) return '';
        const now = Date.now();
        const diff = (now - d.getTime()) / 1000;
        if (diff < 60) return t('time.now') || 'agora';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h';
        if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
        return d.toLocaleDateString();
      } catch { return ''; }
    })();

    const channelLabel = item.conversation_handle
      ? '@' + item.conversation_handle
      : (item.conversation_name || '');

    return (
      <TouchableOpacity
        style={[sty.row, { borderBottomColor: colors.border }]}
        onPress={() => openConversation(item)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={channelLabel}
      >
        <AvatarCircle
          email={item.conversation_avatar ? null : item.sender_email}
          name={item.conversation_name || item.sender_name || item.sender_email}
          size={44}
          uri={item.conversation_avatar || null}
        />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={sty.rowTop}>
            <Text
              style={[sty.channel, { color: colors.text }]}
              numberOfLines={1}
            >
              {channelLabel}
            </Text>
            {!!dt && (
              <Text style={[sty.time, { color: colors.textTertiary }]}>{dt}</Text>
            )}
          </View>
          <Text
            style={[sty.preview, { color: colors.textSecondary }]}
            numberOfLines={2}
          >
            <Text style={{ color: colors.textTertiary }}>{item.sender_name || item.sender_email}: </Text>
            {item.content || (item.type === 'image' ? '[image]' : item.type === 'video' ? '[video]' : '')}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[sty.screen, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? 0 : insets.top }]}>
      <View style={[sty.header, { backgroundColor: isDark ? '#1F2C33' : '#6D28D9' }]}>
        <TouchableOpacity
          onPress={() => { try { router.back(); } catch {} }}
          style={sty.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={sty.headerTitle} numberOfLines={1}>#{tag}</Text>
          <Text style={sty.headerSub} numberOfLines={1}>
            {t('chat.hashtagResultsSubtitle') || 'Em canais públicos'}
          </Text>
        </View>
      </View>

      {loading && messages.length === 0 ? (
        <View style={sty.center}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : messages.length === 0 ? (
        <View style={sty.center}>
          <Text style={[sty.empty, { color: colors.textSecondary }]}>
            {errorMsg || (t('chat.hashtagNoResults') || `Nenhuma mensagem com #${tag} ainda.`)}
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(it) => 'h' + String(it.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        />
      )}
    </View>
  );
}

const sty = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  backBtn: { padding: 6, marginRight: 8 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.78)', fontSize: 12, marginTop: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  empty: { fontSize: 14, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  channel: { fontSize: 14, fontWeight: '700', flexShrink: 1, marginRight: 8 },
  time: { fontSize: 11 },
  preview: { fontSize: 13, marginTop: 2 },
});
