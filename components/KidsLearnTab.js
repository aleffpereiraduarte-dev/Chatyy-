import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, FlatList,
  KeyboardAvoidingView, Platform, ActivityIndicator, Animated, Dimensions,
} from 'react-native';
import Svg, { Path, Circle as SvgCircle, Rect, Defs, LinearGradient, Stop, G, Line } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');
let ImagePicker = null;
try { ImagePicker = require('expo-image-picker'); } catch {}

// ─── SVG Icons ───

function IconGraduationCap({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z" fill={color} />
      <Path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z" fill={color} opacity={0.85} />
    </Svg>
  );
}

function IconStar({ size = 18, color = '#fbbf24' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}

function IconSend({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill={color} />
    </Svg>
  );
}

function IconCamera({ size = 20, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <SvgCircle cx="12" cy="13" r="4" />
    </Svg>
  );
}

function IconCheck({ size = 20, color = '#22c55e' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

function IconX({ size = 20, color = '#ef4444' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="18" y1="6" x2="6" y2="18" />
      <Line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  );
}

function IconFire({ size = 16, color = '#f97316' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 23c-4.97 0-9-3.58-9-8 0-3.19 2.13-6.17 3.45-7.58.37-.39 1-.1 1 .46v1.97c0 1.9 1.84 3.4 3.55 2.59.87-.42 1.5-1.27 1.5-2.25V2.5c0-.55.56-.87 1-.58C16.62 4.27 21 8.55 21 15c0 4.42-4.03 8-9 8z" />
    </Svg>
  );
}

// ─── Category Config ───

const CATEGORIES = [
  { key: 'matematica', emoji: '\uD83D\uDD22', color: '#8b5cf6', gradient: ['#7c3aed', '#a78bfa'], i18nKey: 'kids.categories.math' },
  { key: 'portugues', emoji: '\uD83D\uDCDA', color: '#ec4899', gradient: ['#db2777', '#f9a8d4'], i18nKey: 'kids.categories.portuguese' },
  { key: 'ciencias', emoji: '\uD83D\uDD2C', color: '#10b981', gradient: ['#059669', '#6ee7b7'], i18nKey: 'kids.categories.science' },
  { key: 'historia', emoji: '\uD83C\uDFDB\uFE0F', color: '#f59e0b', gradient: ['#d97706', '#fcd34d'], i18nKey: 'kids.categories.history' },
  { key: 'ingles', emoji: '\uD83C\uDF0D', color: '#3b82f6', gradient: ['#2563eb', '#93c5fd'], i18nKey: 'kids.categories.english' },
  { key: 'artes', emoji: '\uD83C\uDFA8', color: '#f43f5e', gradient: ['#e11d48', '#fda4af'], i18nKey: 'kids.categories.art' },
  { key: 'musica', emoji: '\uD83C\uDFB5', color: '#06b6d4', gradient: ['#0891b2', '#67e8f9'], i18nKey: 'kids.categories.music' },
  { key: 'geografia', emoji: '\uD83C\uDF0E', color: '#84cc16', gradient: ['#65a30d', '#bef264'], i18nKey: 'kids.categories.geography' },
];

// ─── Animated Components ───

function TypingDots() {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = (dot, delay) => Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]));
    anim(dot1, 0).start();
    anim(dot2, 200).start();
    anim(dot3, 400).start();
  }, []);
  return (
    <View style={{ flexDirection: 'row', gap: 6, paddingVertical: 8 }}>
      {[dot1, dot2, dot3].map((dot, i) => (
        <Animated.View key={i} style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#8b5cf6',
          opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
          transform: [{ scale: dot.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.3] }) }],
        }} />
      ))}
    </View>
  );
}

function BounceIn({ children, delay = 0 }) {
  const scale = useRef(new Animated.Value(0.3)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, delay, tension: 100, friction: 8, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, delay, duration: 200, useNativeDriver: true }),
    ]).start();
  }, []);
  return (
    <Animated.View style={{ transform: [{ scale }], opacity }}>
      {children}
    </Animated.View>
  );
}

function AvatarIcon({ size = 36 }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#ede9fe', alignItems: 'center', justifyContent: 'center' }}>
      <IconGraduationCap size={size * 0.55} color="#7c3aed" />
    </View>
  );
}

// ─── Star Progress Bar ───
function StarProgress({ stars, maxStars = 5, size = 20 }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {Array.from({ length: maxStars }, (_, i) => (
        <IconStar key={i} size={size} color={i < stars ? '#fbbf24' : '#d1d5db'} />
      ))}
    </View>
  );
}

// ─── Badge card for encouragement/fact/exercise ───
function SpecialCard({ type, content, isDark }) {
  const configs = {
    badge: { bg: isDark ? '#1a2e1a' : '#dcfce7', color: isDark ? '#86efac' : '#166534', icon: '\uD83C\uDFC6' },
    fact: { bg: isDark ? '#2e2a1a' : '#fef3c7', color: isDark ? '#fbbf24' : '#92400e', icon: '\uD83D\uDCA1' },
    exercise: { bg: isDark ? '#1e1145' : '#ede9fe', color: isDark ? '#c4b5fd' : '#5b21b6', icon: '\u270D\uFE0F' },
  };
  const c = configs[type] || configs.fact;
  return (
    <BounceIn>
      <View style={{
        alignSelf: 'center', marginVertical: 6, paddingHorizontal: 18, paddingVertical: 14,
        borderRadius: 20, backgroundColor: c.bg, maxWidth: '92%',
        flexDirection: 'row', alignItems: 'center', gap: 12,
        ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(0,0,0,0.08)' } : {}),
      }}>
        <Text style={{ fontSize: 22 }}>{c.icon}</Text>
        <Text style={{ fontSize: 16, lineHeight: 22, color: c.color, flex: 1, fontWeight: '600' }}>
          {content}
        </Text>
      </View>
    </BounceIn>
  );
}

export default function KidsLearnTab() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [messages, setMessages] = useState([{
    id: '0', role: 'assistant',
    content: t('kids.teacherOne') + ':\n\n' + t('kids.askAnything') + '\n\n' + t('kids.chooseSubject'),
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [level, setLevel] = useState(1);
  const [stars, setStars] = useState(0);
  const [streak, setStreak] = useState(0);
  const [sessions, setSessions] = useState(0);
  const [showCategories, setShowCategories] = useState(true);
  const flatListRef = useRef(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
  }, []);

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loading) return;
    setMessages(prev => [...prev, { id: String(Date.now()), role: 'user', content: text.trim() }]);
    setInput('');
    setLoading(true);
    setShowCategories(false);
    try {
      const res = await api.oneKidsChat(text.trim(), selectedTopic || 'geral');
      const d = res?.data || res || {};
      const reply = d.response || 'Hmm, tive um probleminha. Tenta de novo?';
      if (d.level) setLevel(d.level);
      if (d.sessions) setSessions(d.sessions);
      if (d.stars) setStars(d.stars);
      if (d.streak) setStreak(d.streak);
      const newMsgs = [{ id: String(Date.now() + 1), role: 'assistant', content: reply }];
      if (d.encouragement) newMsgs.push({ id: String(Date.now() + 2), role: 'badge', content: d.encouragement });
      if (d.fun_fact) newMsgs.push({ id: String(Date.now() + 3), role: 'fact', content: d.fun_fact });
      if (d.exercise) newMsgs.push({ id: String(Date.now() + 4), role: 'exercise', content: d.exercise });
      setMessages(prev => [...prev, ...newMsgs]);
    } catch {
      setMessages(prev => [...prev, { id: String(Date.now() + 1), role: 'assistant', content: 'Ops! Algo deu errado. Tenta de novo!' }]);
    } finally { setLoading(false); }
  }, [loading, selectedTopic]);

  useEffect(() => {
    if (messages.length > 1) setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 150);
  }, [messages.length]);

  const LEVEL_LABELS = ['Iniciante', 'Basico', 'Intermediario', 'Avancado', 'Expert'];
  const levelProgress = Math.min(level / 5, 1);

  const renderMessage = useCallback(({ item }) => {
    if (item.role === 'badge' || item.role === 'fact' || item.role === 'exercise') {
      return <SpecialCard type={item.role} content={item.content} isDark={isDark} />;
    }

    const isUser = item.role === 'user';
    return (
      <BounceIn>
        <View style={[s.bubble,
          isUser ? s.userBubble : s.aiBubble,
          {
            backgroundColor: isUser
              ? (Platform.OS === 'web' ? 'linear-gradient(135deg, #8b5cf6, #a855f7)' : '#8b5cf6')
              : (isDark ? '#2d1b4e' : '#fff'),
            ...(Platform.OS === 'web' && !isUser ? { boxShadow: '0 4px 16px rgba(139,92,246,0.12)' } : {}),
          },
        ]}>
          {!isUser && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <AvatarIcon size={36} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#8b5cf6' }}>{t('kids.teacherOne')}</Text>
                {level > 1 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <Text style={{ fontSize: 11, color: '#7c3aed', fontWeight: '700' }}>Lv.{level}</Text>
                    <StarProgress stars={Math.min(stars, 5)} maxStars={5} size={12} />
                  </View>
                )}
              </View>
            </View>
          )}
          <Text style={{
            fontSize: 17, lineHeight: 26, fontWeight: isUser ? '500' : '400',
            color: isUser ? '#fff' : (isDark ? '#e9d5ff' : '#1e1b4b'),
          }}>
            {item.content}
          </Text>
        </View>
      </BounceIn>
    );
  }, [isDark, level, stars, fadeAnim, t]);

  const bg = isDark ? '#0f0720' : '#faf5ff';

  return (
    <KeyboardAvoidingView style={[s.container, { backgroundColor: bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      {/* Colorful gradient header */}
      <View style={[s.header, Platform.OS === 'web'
        ? { background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 40%, #ec4899 70%, #f43f5e 100%)' }
        : { backgroundColor: '#6366f1' }
      ]}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
          <IconGraduationCap size={30} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{t('kids.teacherOne')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
            {/* Level progress bar */}
            <View style={{ flex: 1, height: 6, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 3, maxWidth: 100 }}>
              <View style={{ width: `${levelProgress * 100}%`, height: 6, backgroundColor: '#fbbf24', borderRadius: 3 }} />
            </View>
            <Text style={s.headerSub}>
              {LEVEL_LABELS[Math.min(level - 1, 4)]}
            </Text>
          </View>
        </View>
        {/* Stats badges */}
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          {stars > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
              <IconStar size={14} color="#fbbf24" />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{stars}</Text>
            </View>
          )}
          {streak > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
              <IconFire size={14} color="#f97316" />
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{streak}d</Text>
            </View>
          )}
        </View>
        {selectedTopic && (
          <TouchableOpacity
            onPress={() => { setSelectedTopic(null); setShowCategories(true); }}
            style={{ backgroundColor: 'rgba(255,255,255,0.25)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            accessibilityLabel="Change subject"
            accessibilityRole="button"
          >
            <Text style={{ fontSize: 18 }}>{CATEGORIES.find(c => c.key === selectedTopic)?.emoji}</Text>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
              {t(CATEGORIES.find(c => c.key === selectedTopic)?.i18nKey) || selectedTopic}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      <FlatList ref={flatListRef} data={messages} renderItem={renderMessage} keyExtractor={item => item.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 8 }} showsVerticalScrollIndicator={false}
        ListFooterComponent={loading ? (
          <View style={[s.bubble, s.aiBubble, { backgroundColor: isDark ? '#2d1b4e' : '#fff' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <AvatarIcon size={36} />
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#8b5cf6' }}>{t('kids.teacherOne')}</Text>
            </View>
            <TypingDots />
          </View>
        ) : null}
      />

      {/* Category selection - large, colorful, touch-friendly cards */}
      {showCategories && (
        <View style={s.topicsWrap}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: isDark ? '#a78bfa' : '#6b7280', marginBottom: 12, textAlign: 'center' }}>
            {t('kids.chooseSubject')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {CATEGORIES.map((topic, idx) => (
              <BounceIn key={topic.key} delay={idx * 60}>
                <TouchableOpacity
                  style={[s.topicBtn, {
                    backgroundColor: isDark ? topic.color + '25' : topic.color + '12',
                    borderColor: topic.color + '40',
                    minWidth: (SCREEN_W - 60) / 2 - 10,
                  }]}
                  onPress={() => {
                    setSelectedTopic(topic.key);
                    setShowCategories(false);
                    sendMessage('Quero aprender ' + (t(topic.i18nKey) || topic.key) + '!');
                  }}
                  activeOpacity={0.7}
                  accessibilityLabel={t(topic.i18nKey) || topic.key}
                  accessibilityRole="button"
                >
                  <View style={{
                    width: 44, height: 44, borderRadius: 14,
                    backgroundColor: topic.color + '20', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ fontSize: 24 }}>{topic.emoji}</Text>
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: topic.color }}>
                    {t(topic.i18nKey) || topic.key}
                  </Text>
                </TouchableOpacity>
              </BounceIn>
            ))}
          </View>
        </View>
      )}

      {/* Input bar - large touch targets for kids */}
      <View style={[s.inputBar, { backgroundColor: isDark ? '#1a0f30' : '#fff', borderTopColor: isDark ? 'rgba(139,92,246,0.15)' : 'rgba(0,0,0,0.06)' }]}>
        {ImagePicker && (
          <TouchableOpacity style={s.iconBtn} onPress={async () => {
            try {
              const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
              if (!r.canceled && r.assets?.[0]) sendMessage(input.trim() || 'Me ajuda com esse dever de casa!');
            } catch {}
          }} activeOpacity={0.7} accessibilityLabel="Photo" accessibilityRole="button">
            <IconCamera size={24} color={isDark ? '#a78bfa' : '#8b5cf6'} />
          </TouchableOpacity>
        )}
        <TextInput
          style={[s.input, { backgroundColor: isDark ? '#2d1b4e' : '#f3e8ff', color: isDark ? '#e9d5ff' : '#1e1b4b' }]}
          placeholder={t('kids.homeworkPlaceholder') || 'Qual sua duvida?'}
          placeholderTextColor={isDark ? '#6b5895' : '#a78bfa'}
          value={input} onChangeText={setInput}
          onSubmitEditing={() => sendMessage(input)} returnKeyType="send" maxLength={500} editable={!loading}
        />
        <TouchableOpacity
          style={[s.sendBtn, {
            backgroundColor: input.trim() && !loading ? '#8b5cf6' : (isDark ? '#2d1b4e' : '#e9d5ff'),
            ...(input.trim() && !loading && Platform.OS === 'web' ? { boxShadow: '0 4px 12px rgba(139,92,246,0.35)' } : {}),
          }]}
          onPress={() => sendMessage(input)} disabled={!input.trim() || loading} activeOpacity={0.7}
          accessibilityLabel="Send" accessibilityRole="button"
        >
          {loading
            ? <ActivityIndicator size="small" color="#a78bfa" />
            : <IconSend size={20} color={input.trim() ? '#fff' : '#a78bfa'} />
          }
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.8)', fontWeight: '600' },
  bubble: { maxWidth: '88%', padding: 16, borderRadius: 24, marginBottom: 10 },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 8 },
  aiBubble: { alignSelf: 'flex-start', borderBottomLeftRadius: 8 },
  topicsWrap: { paddingHorizontal: 16, paddingBottom: 14 },
  topicBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14, borderRadius: 20, borderWidth: 2,
    minHeight: 56,
  },
  inputBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10, gap: 8, borderTopWidth: 1 },
  input: { flex: 1, height: 50, borderRadius: 25, paddingHorizontal: 18, fontSize: 17, fontWeight: '500' },
  sendBtn: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
