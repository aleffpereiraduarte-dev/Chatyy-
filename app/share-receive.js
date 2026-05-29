// Share receive screen — opens when user picks Chatyy from the OS share
// sheet. Previously showed only a recent-chats list; if chatConversations()
// failed silently the user just saw a blank screen. Now the header offers
// three always-working quick actions (Publicar no Feed / Status de 24h /
// Nova conversa) plus a searchable chat list below.
import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet, Platform,
  ActivityIndicator, SafeAreaView, TextInput, ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconX, IconSearch, IconSend, IconImage, IconCamera, IconMessageSquare, IconMessageCircle, IconPaperclip, IconFilm } from '../components/Icons';

export default function ShareReceiveScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [sharedPayload, setSharedPayload] = useState(null);

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
    setLoadError(false);
    try {
      const r = await api.chatConversations();
      const list = r?.data?.conversations || r?.data?.chats || r?.conversations || [];
      list.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
      setConversations(list);
    } catch {
      setLoadError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadChats(); }, [loadChats]);

  const filtered = query.trim()
    ? conversations.filter(c => (c.name || c.display_name || c.other_email || '').toLowerCase().includes(query.trim().toLowerCase()))
    : conversations;

  // Direct send (WhatsApp-parity): tap a contact → media/text goes through
  // right away, user sees a toast, app navigates to the conversation. Saves
  // 2 taps vs the old flow (tap → navigate → confirm send).
  const [sendingToId, setSendingToId] = useState(null);
  const handlePickChat = useCallback(async (conv) => {
    if (sendingToId) return;
    setSendingToId(conv.id);
    try {
      if (sharedPayload?.uri && (sharedPayload.type === 'image' || sharedPayload.type === 'video')) {
        // Upload + send in one shot
        const fileName = sharedPayload.name || (sharedPayload.type + '_' + Date.now() + (sharedPayload.type === 'video' ? '.mp4' : '.jpg'));
        const mime = sharedPayload.type === 'video' ? 'video/mp4' : 'image/jpeg';
        const file = Platform.OS === 'web'
          ? await fetch(sharedPayload.uri).then(r => r.blob()).then(b => new File([b], fileName, { type: mime }))
          : { uri: sharedPayload.uri, name: fileName, type: mime };
        await api.chatUploadFile?.(conv.id, file, sharedPayload.text || '', null, sharedPayload.type);
      } else if (sharedPayload?.text) {
        await api.chatSend(conv.id, sharedPayload.text, 'text', null, null, null, null, null);
      }
      router.replace({ pathname: '/chat-conversation', params: { id: String(conv.id), name: conv.name || conv.other_email || '' } });
    } catch {
      // Fallback to old behaviour (navigate with payload) so user doesn't lose the share
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
    } finally {
      setSendingToId(null);
    }
  }, [router, sharedPayload, sendingToId]);

  // Quick action: publish as a feed post. Hands off to the spotlight
  // composer which already knows how to upload + caption + post.
  const handleShareToFeed = useCallback(() => {
    router.replace({
      pathname: '/spotlight',
      params: {
        createPost: '1',
        _shared_uri: sharedPayload?.uri || '',
        _shared_text: sharedPayload?.text || '',
        _shared_type: sharedPayload?.type || 'image',
        _shared_name: sharedPayload?.name || '',
      },
    });
  }, [router, sharedPayload]);

  // Quick action: publish as 24h status story.
  const handleShareToStatus = useCallback(() => {
    router.replace({
      pathname: '/chat',
      params: {
        tab: 'status', new: '1',
        _shared_uri: sharedPayload?.uri || '',
        _shared_type: sharedPayload?.type || 'image',
        _shared_name: sharedPayload?.name || '',
      },
    });
  }, [router, sharedPayload]);

  // Quick action: open "new chat" picker with payload queued.
  const handleShareToNewChat = useCallback(() => {
    router.replace({
      pathname: '/chat-new',
      params: {
        _shared_uri: sharedPayload?.uri || '',
        _shared_text: sharedPayload?.text || '',
        _shared_type: sharedPayload?.type || 'text',
        _shared_name: sharedPayload?.name || '',
      },
    });
  }, [router, sharedPayload]);

  // AuthContext still hydrating → show spinner, not login prompt. Share
  // Extension deep-links boot a cold app, so `user` is briefly null before
  // AsyncStorage restores the saved session. 4s timeout so a stuck auth
  // init doesn't leave the Extension hanging forever on a blank spinner —
  // after that we fall through to the logged-in view and let the action
  // handlers deal with the missing user (most actions check user inline).
  const [authTimedOut, setAuthTimedOut] = useState(false);
  useEffect(() => {
    if (!authLoading) return;
    const t = setTimeout(() => setAuthTimedOut(true), 4000);
    return () => clearTimeout(t);
  }, [authLoading]);
  if (authLoading && !authTimedOut) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }
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

  const QuickAction = ({ icon: Icon, label, desc, color, onPress }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.82}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff',
        borderRadius: 16, paddingVertical: 14, paddingHorizontal: 14,
        borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
      }}
    >
      <View style={{
        width: 48, height: 48, borderRadius: 14,
        backgroundColor: color + '22',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={22} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>{label}</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{desc}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
      <View style={[s.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.replace('/chat')} style={s.headerBtn} accessibilityLabel={t('common.close') || 'Fechar'}>
          <IconX size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('share.title') || 'Compartilhar no Chatyy'}</Text>
          {sharedPayload?.type ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
              {sharedPayload.type === 'image' ? <IconImage size={12} color={colors.textSecondary} /> : sharedPayload.type === 'video' ? <IconFilm size={12} color={colors.textSecondary} /> : sharedPayload.type === 'text' ? <IconMessageSquare size={12} color={colors.textSecondary} /> : <IconPaperclip size={12} color={colors.textSecondary} />}
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                {sharedPayload.type === 'image' ? 'Imagem' : sharedPayload.type === 'video' ? 'Vídeo' : sharedPayload.type === 'text' ? 'Texto' : 'Arquivo'}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {sharedPayload?.uri && sharedPayload.type === 'image' ? (
          <View style={{ marginHorizontal: 12, marginTop: 12, borderRadius: 14, overflow: 'hidden', aspectRatio: 16/9, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
            <Image source={{ uri: sharedPayload.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          </View>
        ) : sharedPayload?.text ? (
          <View style={{ marginHorizontal: 12, marginTop: 12, padding: 14, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
            <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={4}>{sharedPayload.text}</Text>
          </View>
        ) : sharedPayload?.uri ? (
          <View style={{ marginHorizontal: 12, marginTop: 12, padding: 14, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <IconPaperclip size={13} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{sharedPayload.name || sharedPayload.uri.split('/').pop()}</Text>
            </View>
          </View>
        ) : null}

        <View style={{ paddingHorizontal: 12, paddingTop: 14, gap: 10 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 4 }}>
            {(t('share.quickActions') || 'AÇÕES RÁPIDAS').toUpperCase()}
          </Text>
          {/* Status first (WhatsApp-style: "My Status" is the prominent
              destination). Then Feed, then New chat. */}
          <QuickAction
            icon={IconCamera} color="#F59E0B"
            label={t('share.toStatus') || 'Meu Status'}
            desc={t('share.toStatusDesc') || 'Visível por 24h pros seus contatos'}
            onPress={handleShareToStatus}
          />
          <QuickAction
            icon={IconImage} color="#EC4899"
            label={t('share.toFeed') || 'Postar no Feed'}
            desc={t('share.toFeedDesc') || 'Publicação visível pros seus seguidores'}
            onPress={handleShareToFeed}
          />
          <QuickAction
            icon={IconMessageSquare} color="#10B981"
            label={t('share.toNewChat') || 'Nova conversa'}
            desc={t('share.toNewChatDesc') || 'Escolher um contato pra mandar'}
            onPress={handleShareToNewChat}
          />
        </View>

        <View style={{ paddingHorizontal: 12, paddingTop: 22 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 4, marginBottom: 8 }}>
            {(t('share.recentChats') || 'ENVIAR PARA UMA CONVERSA').toUpperCase()}
          </Text>

          {!loading && !loadError && conversations.length > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 6, marginBottom: 8 }}>
              <IconSearch size={16} color={colors.textSecondary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t('share.searchChat') || 'Buscar conversa'}
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, marginLeft: 8, color: colors.text, fontSize: 15 }}
              />
            </View>
          )}

          {loading ? (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <ActivityIndicator size="small" color="#7C3AED" />
            </View>
          ) : loadError ? (
            <View style={{ paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12, backgroundColor: isDark ? 'rgba(239,68,68,0.12)' : '#fee2e2' }}>
              <Text style={{ color: isDark ? '#fca5a5' : '#991b1b', fontSize: 13 }}>
                {t('share.chatsLoadFailed') || 'Não consegui carregar suas conversas agora. Usa as ações rápidas acima.'}
              </Text>
              <TouchableOpacity onPress={() => { setLoading(true); loadChats(); }} activeOpacity={0.7} style={{ marginTop: 10, alignSelf: 'flex-start' }}>
                <Text style={{ color: '#7C3AED', fontWeight: '700', fontSize: 13 }}>
                  {t('common.retry') || 'Tentar novamente'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <IconMessageCircle size={38} color={colors.textSecondary} style={{ marginBottom: 10 }} />
              <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center' }}>
                {t('share.noChats') || 'Nenhuma conversa ainda. Use uma ação rápida acima.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => String(item.id)}
              scrollEnabled={false}
              contentContainerStyle={{ paddingBottom: 8 }}
              renderItem={({ item }) => {
                const displayName = item.name || item.display_name || item.other_email || '—';
                const preview = typeof item.last_message === 'string' ? item.last_message : (item.last_message?.content || '');
                return (
                  <TouchableOpacity
                    onPress={() => handlePickChat(item)}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, gap: 12 }}
                    activeOpacity={0.7}
                  >
                    <AvatarCircle name={displayName} email={item.other_email} size={44} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{displayName}</Text>
                      {preview ? (
                        <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 1 }} numberOfLines={1}>{preview}</Text>
                      ) : null}
                    </View>
                    <IconSend size={18} color={colors.textTertiary} />
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </ScrollView>
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
