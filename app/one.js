import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList,
  KeyboardAvoidingView, Platform, Animated, Easing, Dimensions,
  ScrollView, Modal, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSend, IconArrowLeft, IconZap, IconMail, IconCalendar,
  IconMessageSquare, IconClock, IconPlus, IconSparkles,
  IconX, IconBell, IconMenu,
} from '../components/Icons';
import { useRouter } from 'expo-router';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');
const isWide = SCREEN_W > 700;
const CONTENT_MAX = 720;

// ─── Helpers ───

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function getGreeting(t) {
  const tod = getTimeOfDay();
  if (tod === 'morning') return t('one.goodMorning');
  if (tod === 'afternoon') return t('one.goodAfternoon');
  return t('one.goodEvening');
}

const ROTATING_PHRASES = [
  { text: 'resumir seus emails', color: '#6366f1' },
  { text: 'organizar sua agenda', color: '#8b5cf6' },
  { text: 'te lembrar de compromissos', color: '#ec4899' },
  { text: 'rascunhar respostas', color: '#6366f1' },
  { text: 'agendar reuniões', color: '#8b5cf6' },
  { text: 'te ligar pra lembrar', color: '#ec4899' },
  { text: 'buscar seus arquivos', color: '#6366f1' },
  { text: 'enviar mensagens', color: '#8b5cf6' },
  { text: 'criar eventos no calendário', color: '#ec4899' },
  { text: 'aprender seu estilo', color: '#6366f1' },
  { text: 'responder emails por você', color: '#8b5cf6' },
  { text: 'encontrar contatos', color: '#ec4899' },
  { text: 'marcar reuniões com sua equipe', color: '#6366f1' },
  { text: 'gerenciar suas pastas', color: '#8b5cf6' },
  { text: 'resumir conversas do chat', color: '#ec4899' },
  { text: 'planejar seu dia', color: '#6366f1' },
  { text: 'priorizar tarefas urgentes', color: '#8b5cf6' },
  { text: 'encaminhar emails importantes', color: '#ec4899' },
  { text: 'criar lembretes', color: '#6366f1' },
  { text: 'organizar seus documentos', color: '#8b5cf6' },
  { text: 'sugerir respostas inteligentes', color: '#ec4899' },
  { text: 'acompanhar prazos', color: '#6366f1' },
  { text: 'preparar briefings do dia', color: '#8b5cf6' },
  { text: 'traduzir mensagens', color: '#ec4899' },
  { text: 'te ajudar em Tudo ✨', color: '#7c3aed' },
];

// ─── Animated rotating text ───

function RotatingText({ isDark }) {
  const [index, setIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let timeout;
    const cycle = () => {
      // Last phrase ("Tudo") stays longer
      const isLast = index === ROTATING_PHRASES.length - 1;
      const delay = isLast ? 4000 : 2200;
      timeout = setTimeout(() => {
        // Fade out + slide up
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(slideAnim, { toValue: -20, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
        ]).start(() => {
          setIndex(prev => (prev + 1) % ROTATING_PHRASES.length);
          slideAnim.setValue(20);
          // Fade in + slide from below
          Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
            Animated.timing(slideAnim, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
          ]).start();
        });
      }, delay);
    };
    cycle();
    return () => clearTimeout(timeout);
  }, [index]);

  const phrase = ROTATING_PHRASES[index];

  return (
    <View style={st.rotatingWrap}>
      <Animated.Text
        style={[st.rotatingText, {
          color: phrase.color,
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }],
        }]}
      >
        {phrase.text}
      </Animated.Text>
    </View>
  );
}

// ─── Pulsing logo ───

function PulsingLogo() {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.1)).current;
  const ringAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.parallel([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0.35, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(ringAnim, { toValue: 0.6, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]),
      Animated.parallel([
        Animated.timing(pulseAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0.1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(ringAnim, { toValue: 0.3, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    ])).start();
  }, []);

  return (
    <View style={st.logoWrap}>
      {/* Outer glow */}
      <Animated.View style={[st.logoGlowOuter, { opacity: glowAnim, transform: [{ scale: pulseAnim }] }]} />
      {/* Ring */}
      <Animated.View style={[st.logoRing, { opacity: ringAnim, transform: [{ scale: pulseAnim }] }]} />
      {/* Main circle */}
      <Animated.View style={[st.logoCircle, { transform: [{ scale: pulseAnim }] }]}>
        <Text style={st.logoText}>One</Text>
        <View style={st.logoSparkle}>
          <IconSparkles size={14} color="#fff" />
        </View>
      </Animated.View>
    </View>
  );
}

function getSuggestions(t) {
  const tod = getTimeOfDay();
  if (tod === 'morning') return [
    { text: t('one.todaySummary'), icon: IconMail },
    { text: t('one.whatsToday'), icon: IconCalendar },
    { text: t('one.draftEmail'), icon: IconSend },
    { text: t('one.sendMessage'), icon: IconMessageSquare },
  ];
  if (tod === 'afternoon') return [
    { text: t('one.unreadEmails'), icon: IconMail },
    { text: t('one.upcomingEvents'), icon: IconCalendar },
    { text: t('one.sendMessage'), icon: IconMessageSquare },
    { text: t('one.setReminder'), icon: IconBell },
  ];
  return [
    { text: t('one.daySummary'), icon: IconMail },
    { text: t('one.tomorrowAgenda'), icon: IconCalendar },
    { text: t('one.setReminder'), icon: IconBell },
    { text: t('one.sendMessage'), icon: IconMessageSquare },
  ];
}

// ─── Markdown parser ───

function parseMarkdown(text, textColor, isDark) {
  if (!text) return null;
  const elements = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeLines = [];
  let codeKey = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <View key={`code-${codeKey++}`} style={st.codeBlock}>
            <Text style={st.codeText} selectable>{codeLines.join('\n')}</Text>
          </View>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }
    if (!line.trim()) { elements.push(<View key={`br-${li}`} style={{ height: 8 }} />); continue; }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (bulletMatch) {
      const indent = Math.min(Math.floor((bulletMatch[1] || '').length / 2), 3);
      elements.push(
        <View key={`li-${li}`} style={[st.bulletRow, { marginLeft: indent * 16 }]}>
          <Text style={[st.bulletDot, { color: textColor }]}>{'\u2022'}</Text>
          <Text style={[st.bulletText, { color: textColor }]} selectable>{fmtInline(bulletMatch[2], textColor, isDark)}</Text>
        </View>
      );
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (numMatch) {
      const num = line.match(/(\d+)/)[1];
      elements.push(
        <View key={`ol-${li}`} style={st.bulletRow}>
          <Text style={[st.bulletNum, { color: textColor }]}>{num}.</Text>
          <Text style={[st.bulletText, { color: textColor }]} selectable>{fmtInline(numMatch[2], textColor, isDark)}</Text>
        </View>
      );
      continue;
    }

    elements.push(
      <Text key={`p-${li}`} style={[st.msgText, { color: textColor }]} selectable>
        {fmtInline(line, textColor, isDark)}
      </Text>
    );
  }

  if (inCodeBlock && codeLines.length) {
    elements.push(
      <View key={`code-${codeKey}`} style={st.codeBlock}>
        <Text style={st.codeText} selectable>{codeLines.join('\n')}</Text>
      </View>
    );
  }
  return elements;
}

function fmtInline(text, textColor, isDark) {
  if (!text) return text;
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|https?:\/\/[^\s)]+)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**'))
      return <Text key={i} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <Text key={i} style={[st.inlineCode, { backgroundColor: isDark ? '#2a2a3d' : '#f0f0f5' }]}>{part.slice(1, -1)}</Text>;
    if (/^https?:\/\//.test(part))
      return <Text key={i} style={{ color: '#6366f1', textDecorationLine: 'underline' }} onPress={() => Linking.openURL(part)}>{part}</Text>;
    return part;
  });
}

// ─── Thinking indicator (ChatGPT style) ───

function ThinkingIndicator({ colors, isDark, t }) {
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 200),
        Animated.timing(dot, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(dot, { toValue: 0.3, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]))
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={st.msgContainer}>
      <View style={st.msgInner}>
        <View style={[st.avatar, { backgroundColor: '#6366f1' }]}>
          <IconSparkles size={16} color="#fff" />
        </View>
        <View style={st.msgBody}>
          <View style={st.thinkRow}>
            {dots.map((dot, i) => (
              <Animated.View key={i} style={[st.thinkDot, { backgroundColor: isDark ? '#8b8ba3' : '#999', opacity: dot }]} />
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Message row (ChatGPT style - full width, no bubbles) ───

function MessageRow({ item, colors, isDark }) {
  const isUser = item.role === 'user';
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== 'web' }).start();
  }, []);

  return (
    <Animated.View style={[
      st.msgContainer,
      isUser && { backgroundColor: isDark ? '#1a1a2e' : '#f7f7f8' },
      { opacity: fadeAnim },
    ]}>
      <View style={[st.msgInner, isWide && { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' }]}>
        {/* Avatar */}
        {isUser ? (
          <View style={[st.avatar, { backgroundColor: isDark ? '#4a4a6a' : '#d1d1e0' }]}>
            <Text style={st.avatarText}>
              {item.userName?.charAt(0)?.toUpperCase() || '?'}
            </Text>
          </View>
        ) : (
          <View style={[st.avatar, { backgroundColor: '#6366f1' }]}>
            <IconSparkles size={16} color="#fff" />
          </View>
        )}

        {/* Content */}
        <View style={st.msgBody}>
          <Text style={[st.msgAuthor, { color: isUser ? colors.text : '#6366f1' }]}>
            {isUser ? 'Você' : 'One'}
          </Text>
          {isUser ? (
            <Text style={[st.msgText, { color: colors.text }]} selectable>{item.content}</Text>
          ) : (
            <View style={st.mdContent}>{parseMarkdown(item.content, colors.text, isDark)}</View>
          )}
          {/* Tool actions hidden - cleaner UI */}
        </View>
      </View>
    </Animated.View>
  );
}

// ─── History sidebar ───

function HistorySidebar({ visible, onClose, conversations, onSelect, currentId, colors, isDark, t, insets }) {
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={st.sidebarOverlay}>
        <TouchableOpacity style={st.sidebarDim} activeOpacity={1} onPress={onClose} />
        <View style={[st.sidebar, {
          backgroundColor: isDark ? '#111128' : '#f9f9fb',
          paddingTop: insets.top + 8,
        }]}>
          <View style={st.sidebarHeader}>
            <Text style={[st.sidebarTitle, { color: colors.text }]}>{t('one.history')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView style={st.sidebarList} showsVerticalScrollIndicator={false}>
            {conversations.length === 0 && (
              <Text style={[st.sidebarEmpty, { color: colors.textTertiary }]}>{t('one.noConversations')}</Text>
            )}
            {conversations.map((c) => {
              const active = c.id === currentId;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[st.sidebarItem, active && { backgroundColor: isDark ? '#1f1f3a' : '#ededf5' }]}
                  onPress={() => { onSelect(c); onClose(); }}
                  activeOpacity={0.7}
                >
                  <Text style={[st.sidebarItemText, { color: active ? '#6366f1' : colors.text }]} numberOfLines={1}>
                    {c.title || `#${c.id}`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Main Screen ───

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState([]);
  const flatListRef = useRef(null);

  const firstName = user?.name?.split(' ')[0] || user?.email?.split('@')[0] || '';

  const [initialLoaded, setInitialLoaded] = useState(false);

  // Load conversations and auto-restore the most recent one
  const loadConversations = useCallback(async (autoRestore = false) => {
    try {
      const res = await api.oneHistory();
      let convos = [];
      if (res?.success && res.data?.conversations) convos = res.data.conversations;
      else if (res?.success && Array.isArray(res.data)) convos = res.data;
      setConversations(convos);

      // Auto-restore last conversation if < 8 hours old, otherwise start fresh
      if (autoRestore && convos.length > 0 && !conversationId && messages.length === 0) {
        const last = convos[0]; // most recent
        const lastUpdated = new Date(last.updated_at || last.created_at);
        const hoursAgo = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);
        if (hoursAgo >= 8) return; // too old, start fresh chat
        setConversationId(last.id);
        try {
          const hRes = await api.oneHistory(last.id);
          const msgs = hRes?.data?.messages || (Array.isArray(hRes?.data) ? hRes.data : []);
          if (msgs.length > 0) {
            setMessages(msgs.map((m, i) => ({
              id: `h-${i}`, role: m.role, content: m.content,
              actions: m.tool_calls ? JSON.parse(m.tool_calls || '[]') : [],
              userName: firstName,
            })));
          }
        } catch {}
      }
    } catch {}
  }, [conversationId, messages.length, firstName]);

  useEffect(() => {
    if (!initialLoaded) {
      setInitialLoaded(true);
      loadConversations(true);
    }
  }, [initialLoaded]);

  const loadConversation = useCallback(async (conv) => {
    setConversationId(conv.id);
    setMessages([]);
    setLoading(true);
    try {
      const res = await api.oneHistory(conv.id);
      const msgs = res?.data?.messages || (Array.isArray(res?.data) ? res.data : []);
      setMessages(msgs.map((m, i) => ({
        id: `h-${i}`, role: m.role, content: m.content,
        actions: m.tool_calls ? JSON.parse(m.tool_calls || '[]') : [],
        userName: firstName,
      })));
    } catch {} finally { setLoading(false); }
  }, [firstName]);

  const sendMessage = useCallback(async (text) => {
    const msg = (text || inputText).trim();
    if (!msg || loading) return;
    setInputText('');
    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: msg, userName: firstName }]);
    setLoading(true);
    try {
      const result = await api.oneChat(msg, conversationId);
      if (result?.success && result.data) {
        if (result.data.conversation_id) setConversationId(result.data.conversation_id);
        setMessages(prev => [...prev, {
          id: Date.now() + 1, role: 'assistant',
          content: result.data.response || t('one.errorProcess'),
          actions: result.data.actions || [],
        }]);
      } else {
        setMessages(prev => [...prev, { id: Date.now() + 1, role: 'assistant', content: result?.message || t('one.errorProcess') }]);
      }
    } catch {
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'assistant', content: t('one.error') }]);
    } finally {
      setLoading(false);
      loadConversations(false); // refresh sidebar list
    }
  }, [inputText, loading, conversationId, t, firstName, loadConversations]);

  const newChat = useCallback(() => {
    setMessages([]); setConversationId(null); loadConversations(false);
  }, [loadConversations]);

  const hasMessages = messages.length > 0;

  const renderMessage = useCallback(({ item }) => (
    <MessageRow item={item} colors={colors} isDark={isDark} />
  ), [colors, isDark]);

  // ─── Empty state - beautiful animated ───
  const renderEmpty = () => {
    const greeting = getGreeting(t);
    const suggestions = getSuggestions(t);

    return (
      <View style={st.emptyOuter}>
        {/* Center - logo + animated text */}
        <View style={st.emptyCenter}>
          <PulsingLogo />

          <Text style={[st.emptyGreeting, { color: colors.text }]}>
            {greeting}{firstName ? `, ${firstName}` : ''}
          </Text>

          {/* "Posso te ajudar a..." + rotating text */}
          <View style={st.canHelpRow}>
            <Text style={[st.canHelpText, { color: colors.textSecondary }]}>
              Posso te ajudar a{' '}
            </Text>
            <RotatingText isDark={isDark} />
          </View>
        </View>

        {/* Suggestion chips at bottom */}
        <View style={st.sugArea}>
          <View style={[st.sugGrid, isWide && { maxWidth: CONTENT_MAX }]}>
            {suggestions.map((item, i) => {
              const Icon = item.icon;
              return (
                <TouchableOpacity
                  key={i}
                  style={[st.sugChip, {
                    backgroundColor: isDark ? '#1a1a2e' : '#fff',
                    borderColor: isDark ? '#252540' : '#e0e0ea',
                    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
                  }]}
                  onPress={() => sendMessage(item.text)}
                  activeOpacity={0.7}
                >
                  <Icon size={16} color={isDark ? '#a5a5c0' : '#666'} />
                  <Text style={[st.sugChipText, { color: colors.text }]} numberOfLines={1}>{item.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[st.container, { backgroundColor: isDark ? '#0d0d1a' : '#fff' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header - minimal */}
      <View style={[st.header, {
        paddingTop: insets.top + 4,
        borderBottomColor: isDark ? '#1a1a2e' : '#e8e8ec',
      }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={st.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { loadConversations(false); setHistoryOpen(true); }}
          hitSlop={8} style={st.headerBtn}
        >
          <IconMenu size={20} color={colors.textSecondary} />
        </TouchableOpacity>

        {/* Center title */}
        <View style={st.headerCenter}>
          <View style={[st.headerDot, { backgroundColor: '#6366f1' }]}>
            <IconSparkles size={12} color="#fff" />
          </View>
          <Text style={[st.headerTitle, { color: colors.text }]}>One</Text>
        </View>

        {/* Right: new chat */}
        <TouchableOpacity onPress={newChat} hitSlop={8} style={st.headerBtn}>
          <IconPlus size={20} color={colors.textSecondary} />
        </TouchableOpacity>

        <View style={{ width: 22 }} />
      </View>

      {/* Messages */}
      {hasMessages ? (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => String(item.id)}
          renderItem={renderMessage}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={loading ? <ThinkingIndicator colors={colors} isDark={isDark} t={t} /> : null}
        />
      ) : (
        renderEmpty()
      )}

      {/* Input - ChatGPT style centered */}
      <View style={[st.inputArea, {
        paddingBottom: Math.max(insets.bottom, 12),
        backgroundColor: isDark ? '#0d0d1a' : '#fff',
      }]}>
        <View style={[st.inputWrapper, isWide && { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' }]}>
          <View style={[st.inputBox, {
            backgroundColor: isDark ? '#1a1a2e' : '#f4f4f8',
            borderColor: isDark ? '#252540' : '#ddd',
          }]}>
            <TextInput
              style={[st.input, { color: colors.text, maxHeight: 120 }]}
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
              style={[st.sendBtn, { opacity: inputText.trim() ? 1 : 0.3 }]}
              onPress={() => sendMessage()}
              disabled={!inputText.trim() || loading}
              activeOpacity={0.7}
            >
              <View style={[st.sendCircle, { backgroundColor: inputText.trim() ? '#6366f1' : (isDark ? '#333' : '#ccc') }]}>
                <IconSend size={14} color="#fff" />
              </View>
            </TouchableOpacity>
          </View>
          <Text style={[st.disclaimer, { color: colors.textTertiary }]}>
            {t('one.disclaimer')}
          </Text>
        </View>
      </View>

      {/* History */}
      <HistorySidebar
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        conversations={conversations}
        onSelect={loadConversation}
        currentId={conversationId}
        colors={colors}
        isDark={isDark}
        t={t}
        insets={insets}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───

const st = StyleSheet.create({
  container: { flex: 1 },

  // Header - minimal centered
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 8, paddingBottom: 10, borderBottomWidth: 1,
  },
  headerBtn: { padding: 8 },
  headerCenter: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  headerDot: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  // Messages - full width rows
  msgContainer: {
    paddingVertical: 16, paddingHorizontal: 16,
  },
  msgInner: {
    flexDirection: 'row', gap: 14, maxWidth: CONTENT_MAX,
    ...(isWide ? { alignSelf: 'center', width: '100%' } : {}),
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  msgBody: { flex: 1 },
  msgAuthor: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  mdContent: { gap: 2 },
  msgText: { fontSize: 15, lineHeight: 24 },

  // Actions
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  actionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
  },
  actionLabel: { fontSize: 10, fontWeight: '600' },

  // Code
  codeBlock: {
    backgroundColor: '#1e1e2e', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, marginVertical: 4,
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13, color: '#a6e3a1', lineHeight: 20,
  },
  inlineCode: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, color: '#e06c75',
  },

  // Lists
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginVertical: 1 },
  bulletDot: { fontSize: 16, lineHeight: 24 },
  bulletNum: { fontSize: 14, lineHeight: 24, fontWeight: '600', minWidth: 18 },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 24 },

  // Thinking
  thinkRow: { flexDirection: 'row', gap: 5, paddingVertical: 4 },
  thinkDot: { width: 8, height: 8, borderRadius: 4 },

  // Pulsing logo
  logoWrap: {
    width: 110, height: 110, alignItems: 'center', justifyContent: 'center', marginBottom: 28,
  },
  logoGlowOuter: {
    position: 'absolute', width: 110, height: 110, borderRadius: 55,
    backgroundColor: '#7c3aed',
  },
  logoRing: {
    position: 'absolute', width: 88, height: 88, borderRadius: 44,
    borderWidth: 2, borderColor: '#a78bfa', backgroundColor: 'transparent',
  },
  logoCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#6366f1', alignItems: 'center', justifyContent: 'center',
  },
  logoText: {
    color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: -0.5, marginTop: 2,
  },
  logoSparkle: {
    position: 'absolute', top: 8, right: 8,
  },

  // Animated rotating text
  rotatingWrap: { height: 32, justifyContent: 'center', overflow: 'hidden' },
  rotatingText: { fontSize: 18, fontWeight: '700' },

  // Empty state - ChatGPT style
  emptyOuter: { flex: 1, justifyContent: 'space-between' },
  emptyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyGreeting: { fontSize: 24, fontWeight: '700', marginBottom: 12, letterSpacing: -0.3 },
  canHelpRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  canHelpText: { fontSize: 18, fontWeight: '400' },

  // Suggestion chips - bottom area
  sugArea: { paddingHorizontal: 16, paddingBottom: 8 },
  sugGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
    ...(isWide ? { alignSelf: 'center', width: '100%' } : {}),
  },
  sugChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 20, borderWidth: 1,
    width: isWide ? 'auto' : '47%',
  },
  sugChipText: { fontSize: 13, fontWeight: '500', flex: 1 },

  // Input - ChatGPT style
  inputArea: { paddingHorizontal: 16, paddingTop: 8 },
  inputWrapper: {},
  inputBox: {
    flexDirection: 'row', alignItems: 'flex-end',
    borderRadius: 24, borderWidth: 1,
    paddingLeft: 18, paddingRight: 6, paddingVertical: 4,
  },
  input: {
    flex: 1, fontSize: 15, minHeight: 36,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
  },
  sendBtn: { padding: 4, marginBottom: 2 },
  sendCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  disclaimer: { fontSize: 11, textAlign: 'center', marginTop: 6, marginBottom: 2 },

  // History sidebar
  sidebarOverlay: { flex: 1, flexDirection: 'row' },
  sidebarDim: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sidebar: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 280,
    shadowColor: '#000', shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15, shadowRadius: 10, elevation: 10,
  },
  sidebarHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  sidebarTitle: { fontSize: 17, fontWeight: '700' },
  sidebarList: { flex: 1, paddingVertical: 8 },
  sidebarEmpty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  sidebarItem: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 8, marginHorizontal: 8, marginVertical: 1,
  },
  sidebarItemText: { fontSize: 14, fontWeight: '500' },
});
