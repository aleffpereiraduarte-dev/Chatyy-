// Share receive screen — opens when user picks Chatyy from the OS share sheet.
// Shows recent chats (WhatsApp-style) and lets them send the shared media/text
// to the selected conversation. Read via Linking for text/URL shares; for file
// shares the content:// URI comes through as the initial URL on Android.
import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet, Platform,
  ActivityIndicator, SafeAreaView, TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconX, IconSearch, IconSend } from '../components/Icons';

export default function ShareReceiveScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sharedPayload, setSharedPayload] = useState(null);

  // Parse the shared content from params (set by the deep-link handler in _layout.js)
  useEffect(() => {
    const payload = {
      uri: params.uri || params.file || null,
      text: params.text || null,
      type: params.type || 'text',
      name: params.name || null,
    };
    if (payload.uri || payload.text) setSharedPayload(payload);
  }, [params]);

  const loadChats = useCallback(async () => {
    try {
      const r = await api.chatConversations();
      const list = r?.data?.conversations || r?.data?.chats || [];
      // Sort by last_message_at desc so frequent contacts top the list
      list.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
      setConversations(list);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadChats(); }, [loadChats]);

  const filtered = query.trim()
    ? conversations.filter(c => (c.name || c.display_name || c.other_email || '').toLowerCase().includes(query.trim().toLowerCase()))
    : conversations;

  const handlePick = useCallback((conv) => {
    // Hand off to chat-conversation with the shared payload as initial message.
    router.replace({
      pathname: '/chat-conversation',
      params: {
        id: String(conv.id),
        name: conv.name || conv.display_name || conv.other_email || '',
        email: conv.other_email || '',
        _shared_uri: sharedPayload?.uri || '',
        _shared_text: sharedPayload?.text || '',
        _shared_type: sharedPayload?.type || 'text',
        _shared_name: sharedPayload?.name || '',
      },
    });
  }, [router, sharedPayload]);

  if (!user) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ color: colors.text, fontSize: 16, marginBottom: 12, textAlign: 'center' }}>
            {t('share.loginFirst') || 'Faça login no Chatyy pra compartilhar'}
          </Text>
          <TouchableOpacity onPress={() => router.replace('/login')} style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, backgroundColor: '#7C3AED' }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.login') || 'Entrar'}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
      <View style={[s.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.replace('/chat')} style={s.headerBtn}>
          <IconX size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('share.title') || 'Enviar para...'}</Text>
          {sharedPayload?.type ? (
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
              {sharedPayload.type === 'image' ? '🖼️ Imagem' : sharedPayload.type === 'video' ? '🎬 Vídeo' : sharedPayload.type === 'text' ? '✏️ Texto' : '📎 Arquivo'}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Shared content preview */}
      {sharedPayload?.uri && sharedPayload.type === 'image' ? (
        <View style={{ margin: 12, borderRadius: 14, overflow: 'hidden', aspectRatio: 16/9, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
          <Image source={{ uri: sharedPayload.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        </View>
      ) : sharedPayload?.text ? (
        <View style={{ margin: 12, padding: 14, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
          <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={4}>{sharedPayload.text}</Text>
        </View>
      ) : sharedPayload?.uri ? (
        <View style={{ margin: 12, padding: 14, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>📎 {sharedPayload.name || sharedPayload.uri.split('/').pop()}</Text>
        </View>
      ) : null}

      {/* Search */}
      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 6 }}>
          <IconSearch size={16} color={colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('share.searchChat') || 'Buscar conversa'}
            placeholderTextColor={colors.textTertiary}
            style={{ flex: 1, marginLeft: 8, color: colors.text, fontSize: 15 }}
          />
        </View>
      </View>

      {/* Conversation list */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#7C3AED" />
        </View>
      ) : filtered.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ fontSize: 38, marginBottom: 10 }}>💬</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center' }}>
            {t('share.noChats') || 'Nenhuma conversa'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 24 }}
          renderItem={({ item }) => {
            const displayName = item.name || item.display_name || item.other_email || '—';
            return (
              <TouchableOpacity
                onPress={() => handlePick(item)}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, gap: 12 }}
                activeOpacity={0.7}
              >
                <AvatarCircle name={displayName} email={item.other_email} size={44} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{displayName}</Text>
                  {item.last_message ? (
                    <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 1 }} numberOfLines={1}>
                      {item.last_message}
                    </Text>
                  ) : null}
                </View>
                <IconSend size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 12, gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700' },
});
