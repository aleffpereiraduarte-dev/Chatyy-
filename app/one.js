import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList,
  KeyboardAvoidingView, Platform, Animated, Easing, Dimensions,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconSend, IconArrowLeft, IconZap, IconMail, IconCalendar, IconMessageSquare, IconFolder } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import { useRouter } from 'expo-router';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');
const isWide = SCREEN_W > 700;

const getSuggestions = (t) => [
  { text: t('one.suggestion1'), icon: IconMail, gradient: ['#6366f1', '#818cf8'] },
  { text: t('one.suggestion2'), icon: IconZap, gradient: ['#8b5cf6', '#a78bfa'] },
  { text: t('one.suggestion3'), icon: IconCalendar, gradient: ['#6366f1', '#818cf8'] },
  { text: t('one.suggestion4'), icon: IconFolder, gradient: ['#8b5cf6', '#a78bfa'] },
];

function TypingIndicator({ colors, isDark }) {
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];

  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 200),
          Animated.timing(dot, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(dot, { toValue: 0.3, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        ])
      )
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={[st.msgRow, st.msgRowAi]}>
      <View style={[st.aiAvatarWrap]}>
        <View style={[st.aiAvatar, { backgroundColor: '#6366f1' }]}>
          <IconZap size={16} color="#fff" />
        </View>
      </View>
      <View style={[st.typingBubble, { backgroundColor: isDark ? '#1a1a2e' : '#f4f4f8' }]}>
        {dots.map((dot, i) => (
          <Animated.View
            key={i}
            style={[st.typingDot, { backgroundColor: '#6366f1', opacity: dot }]}
          />
        ))}
      </View>
    </View>
  );
}

function MessageBubble({ item, colors, isDark, isLast }) {
  const isUser = item.role === 'user';
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(isUser ? 20 : -20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(slideAnim, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  }, []);

  // Parse simple markdown-like formatting
  const formatText = (text) => {
    if (!text) return text;
    // Split by bold markers **text**
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <Text key={i} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
      }
      return part;
    });
  };

  // Split content into paragraphs for better readability
  const paragraphs = (item.content || '').split('\n').filter(p => p.trim());

  return (
    <Animated.View style={[
      st.msgRow,
      isUser ? st.msgRowUser : st.msgRowAi,
      { opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
    ]}>
      {!isUser && (
        <View style={st.aiAvatarWrap}>
          <View style={[st.aiAvatar, { backgroundColor: '#6366f1' }]}>
            <IconZap size={16} color="#fff" />
          </View>
        </View>
      )}
      <View style={[
        st.msgBubble,
        isUser
          ? { backgroundColor: '#6366f1', borderBottomRightRadius: 6 }
          : { backgroundColor: isDark ? '#1a1a2e' : '#f4f4f8', borderBottomLeftRadius: 6 },
        isWide && { maxWidth: 520 },
      ]}>
        {paragraphs.map((p, i) => (
          <Text
            key={i}
            style={[
              st.msgText,
              { color: isUser ? '#fff' : colors.text },
              i < paragraphs.length - 1 && { marginBottom: 8 },
            ]}
            selectable
          >
            {formatText(p)}
          </Text>
        ))}
        {item.actions?.length > 0 && (
          <View style={st.actionsRow}>
            {item.actions.map((a, i) => (
              <View key={i} style={[st.actionChip, { backgroundColor: isUser ? 'rgba(255,255,255,0.2)' : (isDark ? '#252540' : '#e8e8f0') }]}>
                <IconZap size={11} color={isUser ? '#c7d2fe' : '#6366f1'} />
                <Text style={[st.actionText, { color: isUser ? '#e0e7ff' : colors.textSecondary }]}>{a.tool}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

export default function OneScreen() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const flatListRef = useRef(null);

  // Animated gradient for logo
  const glowAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])
    ).start();
  }, []);

  const sendMessage = useCallback(async (text) => {
    const msg = (text || inputText).trim();
    if (!msg || loading) return;

    setInputText('');
    const userMsg = { id: Date.now(), role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const result = await api.oneChat(msg, conversationId);
      if (result?.success && result.data) {
        const response = result.data.response || t('one.errorProcess');
        if (result.data.conversation_id) setConversationId(result.data.conversation_id);

        const aiMsg = {
          id: Date.now() + 1,
          role: 'assistant',
          content: response,
          actions: result.data.actions || [],
        };
        setMessages(prev => [...prev, aiMsg]);
      } else {
        setMessages(prev => [...prev, {
          id: Date.now() + 1, role: 'assistant',
          content: result?.message || t('one.errorProcess'),
        }]);
      }
    } catch {
      setMessages(prev => [...prev, {
        id: Date.now() + 1, role: 'assistant',
        content: t('one.error'),
      }]);
    } finally {
      setLoading(false);
    }
  }, [inputText, loading, conversationId, t]);

  const renderMessage = useCallback(({ item, index }) => (
    <MessageBubble
      item={item}
      colors={colors}
      isDark={isDark}
      isLast={index === messages.length - 1}
    />
  ), [colors, isDark, messages.length]);

  const renderEmpty = () => {
    const firstName = user?.name?.split(' ')[0] || user?.email?.split('@')[0] || '';
    const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.8] });

    return (
      <ScrollView contentContainerStyle={st.emptyScroll} showsVerticalScrollIndicator={false}>
        <View style={st.emptyContainer}>
          {/* Animated logo */}
          <View style={st.logoArea}>
            <Animated.View style={[st.logoGlow, { opacity: glowOpacity }]} />
            <View style={[st.logoCircle]}>
              <IconZap size={36} color="#fff" />
            </View>
          </View>

          <Text style={[st.emptyTitle, { color: colors.text }]}>
            {t('one.greeting')}{firstName ? `, ${firstName}` : ''} 👋
          </Text>
          <Text style={[st.emptySubtitle, { color: colors.textSecondary }]}>
            {t('one.greetingDesc')}
          </Text>

          {/* Suggestion cards */}
          <View style={st.suggestionsGrid}>
            {getSuggestions(t).map((item, i) => {
              const Icon = item.icon;
              return (
                <TouchableOpacity
                  key={i}
                  style={[st.sugCard, {
                    backgroundColor: isDark ? '#1a1a2e' : '#fff',
                    borderColor: isDark ? '#252540' : '#ebebf0',
                    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
                  }]}
                  onPress={() => sendMessage(item.text)}
                  activeOpacity={0.7}
                >
                  <View style={[st.sugIconWrap, { backgroundColor: item.gradient[0] + '18' }]}>
                    <Icon size={18} color={item.gradient[0]} />
                  </View>
                  <Text style={[st.sugText, { color: colors.text }]} numberOfLines={2}>{item.text}</Text>
                  <View style={st.sugArrow}>
                    <Text style={{ color: colors.textTertiary, fontSize: 16 }}>→</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Capabilities */}
          <View style={[st.capSection, { borderTopColor: isDark ? '#252540' : '#ebebf0' }]}>
            <Text style={[st.capTitle, { color: colors.textSecondary }]}>
              {t('one.capabilities') || 'O que posso fazer'}
            </Text>
            <View style={st.capGrid}>
              {[
                { icon: '📧', text: t('one.capEmail') || 'Ler e resumir emails' },
                { icon: '✍️', text: t('one.capDraft') || 'Rascunhar respostas' },
                { icon: '📅', text: t('one.capCalendar') || 'Gerenciar agenda' },
                { icon: '💬', text: t('one.capChat') || 'Enviar mensagens' },
                { icon: '📁', text: t('one.capFiles') || 'Organizar arquivos' },
                { icon: '🔍', text: t('one.capSearch') || 'Buscar informacoes' },
              ].map((cap, i) => (
                <View key={i} style={st.capItem}>
                  <Text style={st.capIcon}>{cap.icon}</Text>
                  <Text style={[st.capText, { color: colors.textSecondary }]}>{cap.text}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    );
  };

  const hasMessages = messages.length > 0;

  return (
    <KeyboardAvoidingView
      style={[st.container, { backgroundColor: isDark ? '#0d0d1a' : '#fafafe' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={[st.header, {
        paddingTop: insets.top + 8,
        backgroundColor: isDark ? '#0d0d1a' : '#fff',
        borderBottomColor: isDark ? '#1a1a2e' : '#ebebf0',
      }]}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn} hitSlop={12}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={[st.headerAvatar, { backgroundColor: '#6366f1' }]}>
          <IconZap size={18} color="#fff" />
        </View>
        <View style={st.headerInfo}>
          <Text style={[st.headerName, { color: colors.text }]}>One</Text>
          <View style={st.headerStatusRow}>
            <View style={st.statusDot} />
            <Text style={[st.headerStatus, { color: '#22c55e' }]}>
              {t('one.online') || 'Online'}
            </Text>
          </View>
        </View>
        {hasMessages && (
          <TouchableOpacity
            style={[st.newChatBtn, { backgroundColor: isDark ? '#1a1a2e' : '#f0f0f5' }]}
            onPress={() => { setMessages([]); setConversationId(null); }}
            hitSlop={8}
          >
            <Text style={{ color: '#6366f1', fontSize: 13, fontWeight: '600' }}>
              {t('one.newChat') || 'Nova conversa'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      {hasMessages ? (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => String(item.id)}
          renderItem={renderMessage}
          contentContainerStyle={st.messagesList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={loading ? <TypingIndicator colors={colors} isDark={isDark} /> : null}
        />
      ) : (
        renderEmpty()
      )}

      {/* Input bar */}
      <View style={[st.inputArea, {
        paddingBottom: Math.max(insets.bottom, 12),
        backgroundColor: isDark ? '#0d0d1a' : '#fff',
        borderTopColor: isDark ? '#1a1a2e' : '#ebebf0',
      }]}>
        <View style={[st.inputRow, {
          backgroundColor: isDark ? '#1a1a2e' : '#f4f4f8',
          borderColor: isDark ? '#252540' : '#e0e0ea',
        }]}>
          <TextInput
            style={[st.input, { color: colors.text }]}
            placeholder={t('one.placeholder')}
            placeholderTextColor={colors.textTertiary}
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={() => sendMessage()}
            returnKeyType="send"
            multiline
            maxLength={2000}
            editable={!loading}
          />
          <TouchableOpacity
            style={[st.sendBtn, {
              backgroundColor: inputText.trim() ? '#6366f1' : 'transparent',
            }]}
            onPress={() => sendMessage()}
            disabled={!inputText.trim() || loading}
            activeOpacity={0.7}
          >
            <IconSend size={18} color={inputText.trim() ? '#fff' : colors.textTertiary} />
          </TouchableOpacity>
        </View>
        <Text style={[st.disclaimer, { color: colors.textTertiary }]}>
          {t('one.disclaimer') || 'One pode cometer erros. Verifique informacoes importantes.'}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14,
    paddingBottom: 12, borderBottomWidth: 1, gap: 10,
  },
  backBtn: { padding: 6, marginRight: -2 },
  headerAvatar: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  headerInfo: { flex: 1 },
  headerName: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  headerStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#22c55e' },
  headerStatus: { fontSize: 12, fontWeight: '500' },
  newChatBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },

  // Messages
  messagesList: { padding: 16, gap: 16, paddingBottom: 8 },
  msgRow: { flexDirection: 'row', gap: 10, maxWidth: '88%' },
  msgRowUser: { alignSelf: 'flex-end' },
  msgRowAi: { alignSelf: 'flex-start' },
  aiAvatarWrap: { marginTop: 2 },
  aiAvatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  msgBubble: {
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12,
    flexShrink: 1,
  },
  msgText: { fontSize: 15, lineHeight: 22 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  actionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10,
  },
  actionText: { fontSize: 11, fontWeight: '600' },

  // Typing
  typingBubble: {
    flexDirection: 'row', gap: 6, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomLeftRadius: 6,
  },
  typingDot: { width: 8, height: 8, borderRadius: 4 },

  // Empty state
  emptyScroll: { flexGrow: 1, justifyContent: 'center' },
  emptyContainer: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 32 },
  logoArea: { marginBottom: 20, alignItems: 'center', justifyContent: 'center' },
  logoGlow: {
    position: 'absolute', width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#6366f1',
  },
  logoCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#6366f1',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#6366f1', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 12, elevation: 8,
  },
  emptyTitle: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  emptySubtitle: { fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 32, maxWidth: 320 },

  // Suggestions
  suggestionsGrid: {
    width: '100%', maxWidth: 440, gap: 10,
  },
  sugCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: 16, borderWidth: 1,
  },
  sugIconWrap: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  sugText: { flex: 1, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  sugArrow: { paddingLeft: 4 },

  // Capabilities
  capSection: { marginTop: 32, paddingTop: 24, borderTopWidth: 1, width: '100%', maxWidth: 440 },
  capTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14, textAlign: 'center' },
  capGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  capItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  capIcon: { fontSize: 14 },
  capText: { fontSize: 13 },

  // Input
  inputArea: { paddingHorizontal: 14, paddingTop: 10, borderTopWidth: 1 },
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    borderRadius: 24, borderWidth: 1,
    paddingLeft: 18, paddingRight: 6, paddingVertical: 4,
  },
  input: {
    flex: 1, fontSize: 15, maxHeight: 100, minHeight: 36,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', marginBottom: 1,
  },
  disclaimer: { fontSize: 11, textAlign: 'center', marginTop: 8, marginBottom: 2 },
});
