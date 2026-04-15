import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconEye, IconShield, IconCamera, IconVideo, IconMusic, IconPaperclip, IconNavigation, IconFilm } from '../components/Icons';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

export default function ParentalChildChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const childEmail = params.child_email;
  const conversationId = params.conversation_id;
  const chatName = params.chat_name || t('parental.chats');

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.parentalChildMessages(childEmail, conversationId);
      if (r.success) setMessages(r.data?.messages || []);
    } catch {} finally { setLoading(false); }
  }, [childEmail, conversationId]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  const isChild = (senderEmail) => senderEmail === childEmail;

  const renderMessage = ({ item }) => {
    const fromChild = isChild(item.sender_email);
    const senderName = item.sender_name || item.sender_email?.split('@')[0] || '?';
    const time = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let content = item.content;
    let contentIcon = null;
    if (item.type === 'image') { contentIcon = <IconCamera size={16} color="#64748b" />; content = t('parental.image') + (item.file_name ? ` (${item.file_name})` : ''); }
    else if (item.type === 'video') { contentIcon = <IconVideo size={16} color="#64748b" />; content = t('parental.video'); }
    else if (item.type === 'audio' || item.type === 'voice') { contentIcon = <IconMusic size={16} color="#64748b" />; content = t('parental.audio'); }
    else if (item.type === 'file') { contentIcon = <IconPaperclip size={16} color="#64748b" />; content = item.file_name || t('parental.unknown'); }
    else if (item.type === 'location') { contentIcon = <IconNavigation size={16} color="#3b82f6" />; content = t('parental.locationMsg'); }
    else if (item.type === 'gif') { contentIcon = <IconFilm size={16} color="#64748b" />; content = t('parental.gif'); }

    return (
      <View style={[s.msgRow, fromChild ? s.msgRowRight : s.msgRowLeft]}>
        <View style={[
          s.msgBubble,
          fromChild
            ? { backgroundColor: isDark ? '#4C1D95' : '#EDE9FE', borderBottomRightRadius: 4 }
            : { backgroundColor: isDark ? '#1e293b' : '#fff', borderBottomLeftRadius: 4 }
        ]}>
          {!fromChild && <Text style={[s.msgSender, { color: ACCENT }]}>{senderName}</Text>}
          {contentIcon ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {contentIcon}
              <Text style={[s.msgText, { color: colors.text }]}>{content}</Text>
            </View>
          ) : (
            <Text style={[s.msgText, { color: colors.text }]}>{content}</Text>
          )}
          <Text style={[s.msgTime, { color: colors.textSecondary }]}>{time}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: colors.text }]}>{chatName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <IconEye size={11} color='#f59e0b' />
            <Text style={[s.headerSub, { color: '#f59e0b' }]}>{t('parental.readOnly')}</Text>
          </View>
        </View>
      </View>

      {/* Monitoring Banner */}
      <View style={[s.banner, { backgroundColor: isDark ? '#1a2332' : '#fef3cd' }]}>
        <IconShield size={14} color="#f59e0b" />
        <Text style={[s.bannerText, { color: isDark ? '#fbbf24' : '#856404' }]}>{t('parental.viewingChild')}</Text>
      </View>

      {/* Messages */}
      {loading ? (
        <ActivityIndicator size="large" color={ACCENT} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={messages}
          keyExtractor={item => String(item.id)}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
          ListEmptyComponent={<Text style={[s.emptyText, { color: colors.textSecondary }]}>Nenhuma mensagem</Text>}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, gap: 12 },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  headerSub: { fontSize: 11 },
  banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  bannerText: { fontSize: 12, flex: 1 },
  msgRow: { marginBottom: 4, paddingHorizontal: 8 },
  msgRowLeft: { alignItems: 'flex-start' },
  msgRowRight: { alignItems: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  msgSender: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  msgText: { fontSize: 15, lineHeight: 20 },
  msgTime: { fontSize: 10, alignSelf: 'flex-end', marginTop: 4 },
  emptyText: { textAlign: 'center', marginTop: 40, fontSize: 14 },
});
